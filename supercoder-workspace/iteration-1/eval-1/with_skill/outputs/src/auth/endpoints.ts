import { Request, Response } from 'express';
import { generateTokens, refreshAccessToken, TokenPayload } from './jwt';

const MOCK_USERS = new Map([
  ['admin@natively.app', { password: 'admin123', userId: '1', role: 'admin' }],
  ['user@natively.app', { password: 'user123', userId: '2', role: 'user' }],
]);

export interface LoginRequest {
  email: string;
  password: string;
}

export function login(req: Request<{}, {}, LoginRequest>, res: Response) {
  const { email, password } = req.body;
  const user = MOCK_USERS.get(email);

  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const payload: TokenPayload = {
    userId: user.userId,
    email,
    role: user.role,
  };

  const tokens = generateTokens(payload);
  return res.json(tokens);
}

export function refresh(req: Request, res: Response) {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const tokens = refreshAccessToken(refreshToken);
    return res.json(tokens);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
}