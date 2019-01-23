import { Logger } from 'botpress/sdk'
import { checkRule } from 'common/auth'
import { WorkspaceService } from 'core/services/workspace-service'
import { NextFunction, Request, Response } from 'express'
import Joi from 'joi'

import { RequestWithUser } from '../misc/interfaces'
import AuthService from '../services/auth/auth-service'
import { AssertionError, ProcessingError, UnauthorizedAccessError } from '../services/auth/errors'

export const asyncMiddleware = ({ logger }: { logger: Logger }) => (
  fn: (req: Request, res: Response, next?: NextFunction) => Promise<any>
) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(err => {
    if (!err.skipLogging && !process.IS_PRODUCTION) {
      logger.attachError(err).debug(`Async request error ${err.message}`)
    }

    next(err)
  })
}

export const validateRequestSchema = (property: string, req: Request, schema: Joi.AnySchema) => {
  const result = Joi.validate(req[property], schema)

  if (result.error) {
    throw new AssertionError(result.error.message)
  }

  Object.assign(req[property], result.value)
}

export const validateBodySchema = (req: Request, schema: Joi.AnySchema) => validateRequestSchema('body', req, schema)

export const success = (res: Response, message: string = 'Success', payload = {}) => {
  res.json({
    status: 'success',
    message,
    payload
  })
}

export const checkTokenHeader = (authService: AuthService, audience?: string) => async (
  req: RequestWithUser,
  res: Response,
  next: NextFunction
) => {
  if (!req.headers.authorization) {
    return next(new UnauthorizedAccessError('No Authorization header'))
  }

  const [scheme, token] = req.headers.authorization.split(' ')
  if (scheme.toLowerCase() !== 'bearer') {
    return next(new UnauthorizedAccessError(`Unknown scheme ${scheme}`))
  }

  if (!token) {
    return next(new UnauthorizedAccessError('Missing authentication token'))
  }

  try {
    const tokenUser = await authService.checkToken(token, audience)

    if (!tokenUser) {
      return next(new UnauthorizedAccessError('Invalid authentication token'))
    }

    req.tokenUser = tokenUser
  } catch (err) {
    return next(new UnauthorizedAccessError('Invalid authentication token'))
  }

  next()
}

export const loadUser = (authService: AuthService) => async (req: Request, res: Response, next: Function) => {
  const reqWithUser = <RequestWithUser>req
  const { tokenUser } = reqWithUser
  if (!tokenUser) {
    return next(new ProcessingError('No tokenUser in request'))
  }

  const authUser = await authService.findUserByEmail(tokenUser.email)
  if (!authUser) {
    return next(new UnauthorizedAccessError('Unknown user'))
  }

  reqWithUser.authUser = authUser
  next()
}

export const assertSuperAdmin = (req: Request, res: Response, next: Function) => {
  const { tokenUser } = <RequestWithUser>req
  if (!tokenUser) {
    return next(new ProcessingError('No tokenUser in request'))
  }

  if (!tokenUser.isSuperAdmin) {
    next(new PermissionError('User needs to be super admin to perform this action'))
    return
  }

  next()
}

class PermissionError extends AssertionError {
  constructor(message: string) {
    super('Permission check error: ' + message)
  }
}

export const needPermissions = (workspaceService: WorkspaceService) => (operation: string, resource: string) => async (
  req: RequestWithUser,
  res: Response,
  next: NextFunction
) => {
  const email = req.tokenUser && req.tokenUser!.email
  const user = workspaceService.findUser({ email })
  if (!user) {
    throw new Error(`User "${email}" does not exists`)
  }

  const role = await workspaceService.getRoleForUser(req.tokenUser!.email)

  if (!role || !checkRule(role.rules, operation, resource)) {
    next(new PermissionError(`user does not have sufficient permissions to ${operation} ${resource}`))
    return
  }

  next()
}