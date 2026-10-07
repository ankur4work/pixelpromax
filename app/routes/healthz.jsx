/**
 * Readiness probe: /healthz
 *
 * Without a health check, Coolify points the proxy at a new container the
 * moment Docker starts it. The container does not serve anything until
 * `prisma migrate deploy` has finished and react-router-serve has bound port
 * 3000, so requests arriving in that window have no listener to reach and hang
 * until the browser gives up.
 *
 * With this endpoint configured as the health check, the proxy only sends
 * traffic once the server is actually answering, and the old container keeps
 * serving until then.
 *
 * Deliberately does NOT touch the database or Shopify: it answers the one
 * question the proxy is asking — is this process ready to take a request.
 */
export function loader() {
  return new Response('ok', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    },
  });
}
