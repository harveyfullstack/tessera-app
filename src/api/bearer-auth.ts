import { timingSafeEqual } from "node:crypto";

export function hasValidBearerToken(request: Request, token: string): boolean {
  const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) {
    return false;
  }

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}
