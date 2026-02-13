import jwt from 'jsonwebtoken';

export interface AuthTokenPayload {
  userId: string;
  username?: string;
}

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
    if (!decoded || typeof decoded.userId !== 'string' || decoded.userId.length === 0) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

