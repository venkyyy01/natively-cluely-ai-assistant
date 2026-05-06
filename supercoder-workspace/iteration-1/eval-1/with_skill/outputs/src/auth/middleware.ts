import type { NextFunction, Request, Response } from "express";
import { type TokenPayload, verifyAccessToken } from "./jwt";

export interface AuthenticatedRequest extends Request {
	user?: TokenPayload;
}

export function authMiddleware(
	req: AuthenticatedRequest,
	res: Response,
	next: NextFunction,
) {
	const authHeader = req.headers.authorization;

	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return res.status(401).json({ error: "No token provided" });
	}

	const token = authHeader.substring(7);

	try {
		const payload = verifyAccessToken(token);
		req.user = payload;
		next();
	} catch (error) {
		return res.status(401).json({ error: "Invalid token" });
	}
}

export function optionalAuthMiddleware(
	req: AuthenticatedRequest,
	res: Response,
	next: NextFunction,
) {
	const authHeader = req.headers.authorization;

	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return next();
	}

	const token = authHeader.substring(7);

	try {
		const payload = verifyAccessToken(token);
		req.user = payload;
	} catch {
		// Silently continue without auth
	}

	next();
}
