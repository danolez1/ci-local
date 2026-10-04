const redact = (url: string): string => url.replace(/\/\/[^@/\s]*@/, "//<redacted>@");

/** Proxy URLs the Docker daemon itself was started with; builds pull base images through them. */
export function daemonProxies(info: string): string[] {
  return info
    .split("\n")
    .map((line) => line.match(/^\s*(HTTPS?) Proxy:\s*(\S+)/i))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => `${m[1]?.toLowerCase()} ${redact(m[2] as string)}`);
}

export const PROXY_HINT =
  "If the daemon's proxy is unreachable, ci-local cannot override it per build. " +
  "On OrbStack run `orb config set network_proxy none` and restart OrbStack; on Docker Desktop turn the proxy off in Settings, Resources, Proxies.";

export function withProxyHint(message: string, buildOutput: string): string {
  return /proxyconnect/.test(buildOutput) ? `${message} (${PROXY_HINT})` : message;
}
