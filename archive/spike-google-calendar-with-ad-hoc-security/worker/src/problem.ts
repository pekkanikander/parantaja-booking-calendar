export function problem(
  status: number,
  title: string,
  detail: string,
  cors: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", status, title, detail }),
    { status, headers: { "Content-Type": "application/problem+json", ...cors } },
  );
}
