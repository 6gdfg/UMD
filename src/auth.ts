import jwt from 'jsonwebtoken';
import { logger } from './logger';

export interface AuthTokenPayload {
  userId: string;
  username?: string;
}

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET is required. Refusing to start without JWT secret.');
  }
  return secret;
})();

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || typeof decoded === 'string') {
      return null;
    }

    const payload = decoded as jwt.JwtPayload;
    if (typeof payload.userId !== 'string' || payload.userId.length === 0) {
      return null;
    }

    const normalized: AuthTokenPayload = {
      userId: payload.userId
    };
    if (typeof payload.username === 'string') {
      normalized.username = payload.username;
    }

    return normalized;
  } catch (error) {
    logger.warn('auth_verify_token_failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
      tokenLength: token.length
    });
    return null;
  }
}
