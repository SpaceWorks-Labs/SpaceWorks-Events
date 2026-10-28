// Run only in the operator container with an empty, owner-only /config mount.
import { randomBytes, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

process.umask(0o077);
const dir = process.env.SWE_SETUP_CONFIG_DIR || "/config";
if (!dir.startsWith("/") || dir.includes("\0")) throw new Error("Use an absolute external configuration directory.");
// Layout: with a frontend hostname, "split" (frontend container on this VPS)
// or "netlify" (the default, for compatibility); without one, "single".
const [hostInput, email, version, frontendInput, layoutInput] = process.argv.slice(2);
const host = hostInput?.toLowerCase();
const frontendHost = frontendInput?.toLowerCase();
const layout = frontendHost ? (layoutInput === "split" ? "split" : "netlify") : "single";
const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
if (frontendHost && (!hostname.test(frontendHost) || frontendHost === host)) throw new Error("Split mode requires a distinct frontend hostname.");
const publicOrigin = `https://${frontendHost || host}`;
const renew = host === "renew-certificates";
if (!renew && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host ?? "") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(version ?? ""))) {
  throw new Error("Usage: setup.mjs events.example.com admin@example.com release-version (or renew-certificates)");
}
if (!renew && ["compose.env", "app.env", "actions-key"].some((name) => existsSync(`${dir}/${name}`))) throw new Error("Configuration exists; refusing to replace secrets. Use renew-certificates only for TLS renewal.");
if (renew && !existsSync(`${dir}/tls/ca.key`)) throw new Error("Existing CA required for certificate renewal.");
// renew-certificates --if-due: renew only within 60 days of the first expiry;
// exit 10 when nothing was due, so the caller can skip restarting services.
if (renew && process.argv.includes("--if-due")) {
  const expiries = ["postgres", "redis", "storage"].map((service) => Date.parse(new X509Certificate(readFileSync(`${dir}/tls/${service}/public.crt`)).validTo));
  const daysLeft = Math.floor((Math.min(...expiries) - Date.now()) / 86_400_000);
  if (daysLeft > 60) {
    console.log(`Internal certificates are valid for ${daysLeft} more days; renewal is not due.`);
    process.exit(10);
  }
}
const write = (name, value) => writeFileSync(`${dir}/${name}`, value, { mode: 0o600 });
const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
mkdirSync(`${dir}/tls`, { recursive: true });
if (!renew) {
  openssl("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650", "-subj", "/CN=Space Works Events private CA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", `${dir}/tls/ca.key`, "-out", `${dir}/tls/ca.crt`);
}
for (const service of ["postgres", "redis", "storage"]) {
  mkdirSync(`${dir}/tls/${service}`, { recursive: true });
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${service}`, "-keyout", `${dir}/tls/${service}/private.key`, "-out", `${dir}/tls/${service}/request.csr`);
  write(`tls/${service}/extensions.cnf`, `subjectAltName=DNS:${service}\nextendedKeyUsage=serverAuth\n`);
  openssl("x509", "-req", "-sha256", "-days", "365", "-in", `${dir}/tls/${service}/request.csr`, "-CA", `${dir}/tls/ca.crt`, "-CAkey", `${dir}/tls/ca.key`, "-CAcreateserial", "-extfile", `${dir}/tls/${service}/extensions.cnf`, "-out", `${dir}/tls/${service}/public.crt`);
}
// Public CA only; never mount the CA signing key into application services.
chmodSync(`${dir}/tls/ca.crt`, 0o644);
if (renew) {
  console.log("Internal TLS certificates renewed for one year. Recreate postgres, redis, storage and app. Keep the original CA and credentials.");
  process.exit(0);
}
const hex = () => randomBytes(32).toString("hex");
const key = () => randomBytes(32).toString("base64");
const adminPassword = hex(), appPassword = hex(), redisPassword = hex(), storageRoot = hex(), storageApp = hex();
const actionsKey = key(), cronSecret = hex(), readinessSecret = hex();
const dbUrl = (user, password) => `postgresql://${user}:${password}@postgres:5432/swevents?sslmode=require&sslcert=/tls/ca.crt&sslaccept=strict`;
const envText = (values) => Object.entries(values).map(([name, value]) => `${name}='${String(value).replaceAll("'", "\\'")}'`).join("\n") + "\n";
write("compose.env", envText({
  PUBLIC_HOST: host, PUBLIC_ORIGIN: publicOrigin, SWE_VERSION: version, SWE_LAYOUT: layout,
  ...(layout === "split" ? { SITE_HOST: frontendHost, SWE_CADDYFILE: "Caddyfile.split" } : {}),
}));
const peerKey = frontendHost ? hex() : undefined;
if (frontendHost) write("frontend.env", envText({
  NEXT_PUBLIC_BASE_URL: publicOrigin, BACKEND_ORIGIN: `https://${host}`,
  NEXT_PUBLIC_BACKEND_ORIGIN: `https://${host}`, FRONTEND_GATEWAY_SECRET: peerKey,
  // Caddy on this VPS overwrites X-Real-IP; Netlify sets its own client-IP header.
  FRONTEND_TRUSTED_IP_HEADER: layout === "split" ? "x-real-ip" : "x-nf-client-connection-ip",
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: key(),
  // Space Works mobile app links, served by the website (docs/MOBILE_API.md#app-links); fill in to claim links.
  ANDROID_APP_PACKAGE_NAME: "", ANDROID_APP_SHA256_FINGERPRINTS: "", APPLE_APP_IDS: "",
}));
write("actions-key", actionsKey);
write("postgres.env", envText({ POSTGRES_USER: "swevents", POSTGRES_DB: "swevents", POSTGRES_PASSWORD: adminPassword, POSTGRES_APP_PASSWORD: appPassword, POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256" }));
write("migrator.env", envText({ DATABASE_URL: dbUrl("swevents", adminPassword), DIRECT_URL: dbUrl("swevents", adminPassword) }));
write("storage.env", envText({ MINIO_ROOT_USER: "swevents-root", MINIO_ROOT_PASSWORD: storageRoot }));
write("storage-init.env", envText({ MC_HOST_local: `https://swevents-root:${storageRoot}@storage:9000`, S3_APP_PASSWORD: storageApp, SSL_CERT_FILE: "/tls/ca.crt" }));
write("app.env", envText({
  NODE_ENV: "production", AUTH_URL: publicOrigin, NEXT_PUBLIC_BASE_URL: publicOrigin,
  ...(frontendHost ? { DEPLOYMENT_MODE: "backend", FRONTEND_GATEWAY_SECRET: peerKey } : {}),
  DATABASE_URL: dbUrl("swevents_app", appPassword), DIRECT_URL: dbUrl("swevents_app", appPassword),
  REDIS_URL: `rediss://default:${redisPassword}@redis:6379`, NODE_EXTRA_CA_CERTS: "/tls/ca.crt",
  AUTH_SECRET: hex(), CRON_SECRET: cronSecret, HEALTHCHECK_SECRET: readinessSecret,
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: actionsKey, MFA_ENCRYPTION_KEY: key(), SUPER_ADMIN_EMAIL: email,
  TRUSTED_PROXY_IP_HEADER: "x-real-ip", S3_BUCKET: "spaceworks-events", S3_REGION: "us-east-1",
  S3_ENDPOINT: "https://storage:9000", S3_ACCESS_KEY_ID: "swevents-app", S3_SECRET_ACCESS_KEY: storageApp, S3_FORCE_PATH_STYLE: "1",
  EMAIL_FROM: `Space Works Events <events@${host}>`, SMTP_HOST: "CHANGE_ME", SMTP_PORT: "587",
  SMTP_SECURE: "false", SMTP_USER: "CHANGE_ME", SMTP_PASSWORD: "CHANGE_ME",
  // Mobile app Google sign-in (API host); Super admin -> Settings overrides it.
  GOOGLE_MOBILE_CLIENT_IDS: "",
  // In the single layout this container also serves the website's app-link files.
  ...(frontendHost ? {} : { ANDROID_APP_PACKAGE_NAME: "", ANDROID_APP_SHA256_FINGERPRINTS: "", APPLE_APP_IDS: "" }),
}));
write("redis.conf", `port 0\ntls-port 6379\ntls-cert-file /data/tls/public.crt\ntls-key-file /data/tls/private.key\ntls-ca-cert-file /tls/ca.crt\ntls-auth-clients no\nrequirepass ${redisPassword}\nappendonly yes\nmaxmemory-policy noeviction\n`);
console.log("Configuration created without printing secrets. Edit app.env: EMAIL_FROM and SMTP_* must use your verified sending domain and authenticated relay. Back up /config securely; do not rerun setup for updates.");
