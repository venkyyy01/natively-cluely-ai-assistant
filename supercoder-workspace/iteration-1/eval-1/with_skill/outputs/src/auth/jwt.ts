import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

export interface TokenPayload {
	userId: string;
	email: string;
	role?: string;
}

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

export function generateTokens(payload: TokenPayload): AuthTokens {
	const accessToken = jwt.sign(payload, JWT_SECRET, {
		expiresIn: ACCESS_TOKEN_EXPIRY,
	});
	const refreshToken = jwt.sign({ ...payload, tokenId: uuidv4() }, JWT_SECRET, {
		expiresIn: REFRESH_TOKEN_EXPIRY,
	});
	return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): TokenPayload {
	return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

export function verifyRefreshToken(
	token: string,
): TokenPayload & { tokenId: string } {
	return jwt.verify(token, JWT_SECRET) as TokenPayload & { tokenId: string };
}

export function refreshAccessToken(refreshToken: string): AuthTokens {
	const payload = verifyRefreshToken(refreshToken);
	const { tokenId, ...userPayload } = payload;
	return generateTokens(userPayload);
}
