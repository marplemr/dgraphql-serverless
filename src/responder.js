// @flow

import accepts from 'accepts'

import {
  Source,
  parse,
  validate,
  execute,
  formatError,
  getOperationAST,
  specifiedRules
} from 'graphql'

import { renderGraphiQL } from './renderGraphiQL'

import type { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql'

import type {
  LambdaAPIGatewayProxyResponder,
  LambdaAPIGatewayProxyEvent,
  LambdaAPIGatewayResult,
  LambdaContext
} from './lambda'

/**
 * All information about a GraphQL request.
 */
export type RequestInfo = {
  /**
   * The parsed GraphQL document.
   */
  document: DocumentNode,

  /**
   * The variable values used at runtime.
   */
  variables: ?{ [name: string]: mixed },

  /**
   * The (optional) operation name requested.
   */
  operationName: ?string,

  /**
   * The result of executing the operation.
   */
  result: ?mixed
}

export type OptionsData = {
  /**
   * A GraphQL schema from graphql-js.
   */
  schema: GraphQLSchema,

  /**
   * A value to pass as the context to the graphql() function.
   */
  context?: ?mixed,

  /**
   * An object to pass as the rootValue to the graphql() function.
   */
  rootValue?: ?mixed,

  /**
   * A boolean to configure whether the output should be pretty-printed.
   */
  pretty?: ?boolean,

  /**
   * An optional function which will be used to format any errors produced by
   * fulfilling a GraphQL operation. If no function is provided, GraphQL's
   * default spec-compliant `formatError` function will be used.
   */
  formatError?: ?(error: GraphQLError) => mixed,

  /**
   * An optional array of validation rules that will be applied on the document
   * in additional to those defined by the GraphQL spec.
   */
  validationRules?: ?Array<mixed>,

  /**
   * An optional function for adding additional metadata to the GraphQL response
   * as a key-value object. The result will be added to "extensions" field in
   * the resulting JSON. This is often a useful place to add development time
   * info such as the runtime of a query or the amount of resources consumed.
   *
   * Information about the request is provided to be used.
   *
   * This function may be async.
   */
  extensions?: ?(info: RequestInfo) => { [key: string]: mixed },

  /**
   * A boolean to optionally enable GraphiQL mode.
   */
  graphiql?: ?boolean
}

export type GraphQLParams = {
  query: ?string,
  variables: ?{ [name: string]: mixed },
  operationName: ?string,
  raw: ?boolean
}

export type OptionsResult = OptionsData | Promise<OptionsData>

/**
 * Used to configure the graphqlHTTP middleware by providing a schema
 * and other configuration options.
 *
 * Options can be provided as an Object, a Promise for an Object, or a Function
 * that returns an Object or a Promise for an Object.
 */
export type Options =
  | ((
    event: LambdaAPIGatewayProxyEvent,
    context: LambdaContext,
    params?: GraphQLParams
  ) => OptionsResult)
  | OptionsResult

/**
 * Middleware for express; takes an options object or function as input to
 * configure behavior, and returns an express middleware.
 */
export function getResponder (options: Options): LambdaAPIGatewayProxyResponder {
  if (!options) {
    throw new Error('GraphQL middleware requires options.')
  }

  return (event: LambdaAPIGatewayProxyEvent, lambdaContext: LambdaContext) => {
    // Higher scoped variables are referred to at various stages in the
    // asynchronous state machine below.
    let params
    let pretty
    let formatErrorFn
    let extensionsFn
    let showGraphiQL
    let query

    let documentAST
    let variables
    let operationName
    let response = { statusCode: 200, headers: {}, body: '' }

    // Promises are used as a mechanism for capturing any thrown errors during
    // the asynchronous process below.

    // Parse the Request to get GraphQL request parameters.
    return getGraphQLParams(event)
      .then(graphQLParams => {
        params = graphQLParams
        // Then, resolve the Options to get OptionsData.
        return new Promise(resolve =>
          resolve(
            typeof options === 'function'
              ? options(event, lambdaContext, params)
              : options
          )
        )
      })
      .then(optionsData => {
        // Assert that optionsData is in fact an Object.
        if (!optionsData || typeof optionsData !== 'object') {
          throw new Error(
            'GraphQL middleware option function must return an options object ' +
              'or a promise which will be resolved to an options object.'
          )
        }

        // Assert that schema is required.
        if (!optionsData.schema) {
          throw new Error('GraphQL middleware options must contain a schema.')
        }

        // Collect information from the options data object.
        const schema = optionsData.schema
        const context = optionsData.context || lambdaContext
        const rootValue = optionsData.rootValue
        const graphiql = optionsData.graphiql
        pretty = optionsData.pretty
        formatErrorFn = optionsData.formatError
        extensionsFn = optionsData.extensions

        let validationRules = specifiedRules
        if (optionsData.validationRules) {
          validationRules = validationRules.concat(optionsData.validationRules)
        }

        // GraphQL HTTP only supports GET and POST methods.
        if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
          response.headers['Allow'] = 'GET, POST'
          response.statusCode = 405
          response.body = 'GraphQL only supports GET and POST requests.'
          return response
        }

        // Get GraphQL params from the request and POST body data.
        query = params.query
        variables = params.variables
        operationName = params.operationName
        showGraphiQL = graphiql && canDisplayGraphiQL(event, params)

        // If there is no query, but GraphiQL will be displayed, do not produce
        // a result, otherwise return a 400: Bad Request.
        if (!query) {
          if (showGraphiQL) {
            return null
          }
          response.statusCode = 400
          response.body = 'Must provide query string.'
          return response
        }

        // GraphQL source.
        const source = new Source(query, 'GraphQL request')

        // Parse source to AST, reporting any syntax error.
        try {
          documentAST = parse(source)
        } catch (syntaxError) {
          // Return 400: Bad Request if any syntax errors errors exist.
          response.statusCode = 400
          response.body = JSON.stringify({ errors: [syntaxError] })
          return response
        }

        // Validate AST, reporting any errors.
        const validationErrors = validate(schema, documentAST, validationRules)
        if (validationErrors.length > 0) {
          // Return 400: Bad Request if any validation errors exist.
          response.statusCode = 400
          response.body = JSON.stringify({ errors: validationErrors })
          return response
        }

        // Only query operations are allowed on GET requests.
        if (event.httpMethod === 'GET') {
          // Determine if this GET request will perform a non-query.
          const operationAST = getOperationAST(documentAST, operationName)
          if (operationAST && operationAST.operation !== 'query') {
            // If GraphiQL can be shown, do not perform this query, but
            // provide it to GraphiQL so that the requester may perform it
            // themselves if desired.
            if (showGraphiQL) {
              return null
            }

            // Otherwise, report a 405: Method Not Allowed error.
            response.headers['Allow'] = 'POST'
            response.statusCode = 405
            response.body = `Can only perform a ${operationAST.operation} operation from a POST request.`
            return response
          }
        }
        // Perform the execution, reporting any errors creating the context.
        try {
          return execute(
            schema,
            documentAST,
            rootValue,
            context,
            variables,
            operationName
          )
        } catch (contextError) {
          // Return 400: Bad Request if any execution context errors exist.
          response.statusCode = 400
          return { errors: [contextError] }
        }
      })
      .then(result => {
        // Collect and apply any metadata extensions if a function was provided.
        // http://facebook.github.io/graphql/#sec-Response-Format
        if (result && extensionsFn) {
          return Promise.resolve(
            extensionsFn({
              document: documentAST,
              variables,
              operationName,
              result
            })
          ).then(extensions => {
            if (extensions && typeof extensions === 'object') {
              ;(result: any).extensions = extensions
            }
            return result
          })
        }
        return result
      })
      .catch(error => {
        // If an error was caught, report the httpError status, or 500.
        response.statusCode = error.status || 500
        response.body = JSON.stringify({ errors: [error] })
        return response
      })
      .then(result => {
        // If no data was included in the result, that indicates a runtime query
        // error, indicate as such with a generic status code.
        // Note: Information about the error itself will still be contained in
        // the resulting JSON payload.
        // http://facebook.github.io/graphql/#sec-Data
        if (result && result.data === null) {
          response.statusCode = 500
        }
        // Format any encountered errors.
        if (result && result.errors) {
          ;(result: any).errors = result.errors.map(
            formatErrorFn || formatError
          )
        }

        // If allowed to show GraphiQL, present it instead of JSON.
        if (showGraphiQL) {
          const payload = renderGraphiQL({
            query,
            variables,
            operationName,
            result
          })
          return sendResponse(response, 'text/html', payload)
        }

        // At this point, result is guaranteed to exist, as the only scenario
        // where it will not is when showGraphiQL is true.
        if (!result) {
          response.statusCode = 500
          response.body = 'Internal Error'
          return response
        }

        // If "pretty" JSON isn't requested, and the server provides a
        // response.json method (express), use that directly.
        // Otherwise use the simplified sendResponse method.
        if (!pretty && typeof response.json === 'function') {
          response.json(result)
        } else {
          const payload = JSON.stringify(result, null, pretty ? 2 : 0)
          return sendResponse(response, 'application/json', payload)
        }
      })
  }
}

function parseBody (body: string): { [string]: string } {
  try {
    return JSON.parse(body)
  } catch (e) {
    return {}
  }
}
/**
 * Provided a "Request" provided by express or connect (typically a node style
 * HTTPClientRequest), Promise the GraphQL request parameters.
 */
function getGraphQLParams (
  event: LambdaAPIGatewayProxyEvent
): Promise<GraphQLParams> {
  const urlData = event.queryStringParameters || {}
  const bodyData = parseBody(event.body) || {}
  const params = parseGraphQLParams(urlData, bodyData)
  return Promise.resolve(params)
}

/**
 * Helper function to get the GraphQL params from the request.
 */
function parseGraphQLParams (
  urlData: { [param: string]: string },
  bodyData: { [param: string]: string }
): GraphQLParams {
  // GraphQL Query string.
  let query = urlData.query || bodyData.query
  if (typeof query !== 'string') {
    query = null
  }

  // Parse the variables if needed.
  let variables = urlData.variables || bodyData.variables
  if (variables && typeof variables === 'string') {
    try {
      variables = JSON.parse(variables)
    } catch (error) {
      // response.statusCode = 400
      // response.body = 'Variables are invalid JSON.'
      // return response
    }
  } else if (typeof variables !== 'object') {
    variables = null
  }

  // Name of GraphQL operation to execute.
  let operationName = urlData.operationName || bodyData.operationName
  if (typeof operationName !== 'string') {
    operationName = null
  }

  const raw = urlData.raw !== undefined || bodyData.raw !== undefined

  return { query, variables, operationName, raw }
}

function mapHeaders (headers) {
  const mapped = {}
  Object.keys(headers).forEach(key => {
    mapped[key.toLowerCase()] = headers[key]
  })
  return mapped
}

/**
 * Helper function to determine if GraphiQL can be displayed.
 */
function canDisplayGraphiQL (
  event: LambdaAPIGatewayProxyEvent,
  params: GraphQLParams
): boolean {
  // If `raw` exists, GraphiQL mode is not enabled.
  // Allowed to show GraphiQL if not requested as raw and this request
  // prefers HTML over JSON.
  const request = { headers: mapHeaders(event.headers) }
  return !params.raw && accepts(request).types(['json', 'html']) === 'html'
}

/**
 * Helper function for sending a response using only the core Node server APIs.
 */
function sendResponse (
  response: LambdaAPIGatewayResult,
  type: string,
  data: string
): LambdaAPIGatewayResult {
  // const chunk = new Buffer(data, 'utf8')
  response.headers['Content-Type'] = type + '; charset=utf-8'
  // response.setHeader('Content-Length', String(chunk.length))
  response.body = data
  return response
}
