import { NextResponse } from "next/server";

/**
 * Shape padrão de erro da API. Todos os handlers devem retornar nesse formato.
 */
export interface ApiError {
  error: string;
  code?: string;
  detail?: string;
}

/**
 * Helper pra retornar erro consistente.
 * @example
 *   return errorResponse("Agente não encontrado", 404, "agent_not_found");
 */
export function errorResponse(
  message: string,
  status: number = 400,
  code?: string,
  detail?: string,
): NextResponse<ApiError> {
  const body: ApiError = { error: message };
  if (code) body.code = code;
  if (detail) body.detail = detail;
  return NextResponse.json(body, { status });
}

/**
 * Helper para 401. Usado em rotas autenticadas quando session não existe.
 */
export function unauthorized(): NextResponse<ApiError> {
  return errorResponse("Não autenticado", 401, "unauthenticated");
}

/**
 * Helper para 404. Usado quando resource não pertence à location do user
 * (disfarça existence pra não vazar info de outros tenants).
 */
export function notFound(resource: string = "Recurso"): NextResponse<ApiError> {
  return errorResponse(`${resource} não encontrado`, 404, "not_found");
}
