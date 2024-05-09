import FailBot from '../lib/failbot.js'
import { nextApp } from '#src/frame/middleware/next.js'
import {
  setFastlySurrogateKey,
  SURROGATE_ENUMS,
} from '#src/frame/middleware/set-fastly-surrogate-key.js'
import { errorCacheControl } from '#src/frame/middleware/cache-control.js'
import statsd from '#src/observability/lib/statsd.js'

const DEBUG_MIDDLEWARE_TESTS = Boolean(JSON.parse(process.env.DEBUG_MIDDLEWARE_TESTS || 'false'))

function shouldLogException(error) {
  const IGNORED_ERRORS = [
    // Client connected aborted
    'ECONNRESET',
  ]

  if (IGNORED_ERRORS.includes(error.code)) {
    return false
  }

  // We should log this exception
  return true
}

async function logException(error, req) {
  if (process.env.NODE_ENV !== 'test' && shouldLogException(error)) {
    await FailBot.report(error, {
      path: req.path,
      url: req.url,
    })
  }
}

function timedOut(req) {
  // The `req.pagePath` can come later so it's not guaranteed to always
  // be present. It's added by the `handle-next-data-path.js` middleware
  // we translates those "cryptic" `/_next/data/...` URLs from
  // client-side routing.
  const incrementTags = [`path:${req.pagePath || req.path}`]
  if (req.context?.currentCategory) {
    incrementTags.push(`product:${req.context.currentCategory}`)
  }
  statsd.increment('middleware.timeout', 1, incrementTags)
}

export default async function handleError(error, req, res, next) {
  // Potentially set by the `connect-timeout` middleware.
  if (req.timedout) {
    timedOut(req, res)
  }

  const responseDone = res.headersSent || req.aborted

  if (req.path.startsWith('/assets') || req.path.startsWith('/_next/static')) {
    if (!responseDone) {
      // By default, Fastly will cache 404 responses unless otherwise
      // told not to.
      // See https://docs.fastly.com/en/guides/how-caching-and-cdns-work#http-status-codes-cached-by-default
      // Let's cache our 404'ing assets conservatively.
      // The Cache-Control is short, and let's use the default surrogate
      // key just in case it was a mistake.
      errorCacheControl(res)
      // Makes sure the surrogate key is NOT the manual one if it failed.
      // This basically unsets what was assumed in the beginning of
      // loading all the middlewares.
      setFastlySurrogateKey(res, SURROGATE_ENUMS.DEFAULT)
    }
  } else if (DEBUG_MIDDLEWARE_TESTS) {
    console.warn('An error occurred in some middleware handler', error)
  }

  try {
    // If the headers have already been sent or the request was aborted...
    if (responseDone) {
      // Report to Failbot
      await logException(error, req)

      // We MUST delegate to the default Express error handler
      return next(error)
    }

    if (!req.context) {
      req.context = {}
    }
    // display error on the page in development and staging, but not in production
    if (process.env.HEROKU_PRODUCTION_APP !== 'true') {
      req.context.error = error
    }

    // Special handling for when a middleware calls `next(404)`
    if (error === 404) {
      // Note that if this fails, it will swallow that error.
      return nextApp.render404(req, res)
    }

    // If the error contains a status code, just send that back. This is usually
    // from a middleware like `express.json()`.
    if (error.statusCode || error.status) {
      return res.sendStatus(error.statusCode || error.status)
    }

    res.statusCode = 500
    // When in local development mode, we don't need the pretty HTML
    // renderig of 500.tsx.
    // Incidentally, as Jan 2024, if you try to execute nextApp.renderError
    // when `NODE_ENV` is 'development' it will hang forever. A problem
    // we can't fully explain but it's also moot because in local dev
    // it's easier to just see the full stack trace in the console
    // and in the client.
    if (process.env.NODE_ENV === 'development') {
      return next(error)
    } else {
      nextApp.renderError(error, req, res, req.path)

      // Report to Failbot AFTER responding to the user
      await logException(error, req)
    }
  } catch (error) {
    console.error('An error occurred in the error handling middleware!', error)
    return next(error)
  }
}
