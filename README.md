# Smart City Portal: Part 2

**External integrations, API gateway simulation and documentation**

Harshit Shah · 2023EBCS665 · Backend / API Development: SGA-2

Citizens report civic problems such as potholes, garbage or broken streetlights. Officers and admins track and resolve them. Part 2 adds:
- geolocation through OpenStreetMap;
- SMS notifications;
- an Express API gateway;
- OpenAPI documentation;
- a Mocha/Chai test suite.

---

## Deliverables checklist

| Deliverable | Where |
|---|---|
| ✅ Swagger/OpenAPI documentation | [docs/openapi.yaml](docs/openapi.yaml), served at **`/docs`** (Swagger UI) and **`/redoc`** (ReDoc) |
| ✅ Gateway service code | [src/gateway/gateway.js](src/gateway/gateway.js) |
| ✅ Mocha/Chai test suite + instructions | [test/](test/), see [Automated tests](#automated-tests). Current result: [docs/test-output.txt](docs/test-output.txt) (38 passing) |
| ✅ Third-party integrations | [src/integrations/geocoder.js](src/integrations/geocoder.js) (OpenStreetMap / Google Maps), [src/integrations/sms.js](src/integrations/sms.js) (Twilio / mock) |
| ✅ Screenshots / screencast of integrations | `npm run demo`, see [Screenshots to capture](#screenshots-to-capture). Sample run: [docs/demo-output.txt](docs/demo-output.txt) |
| ✅ Bonus: deployment | [render.yaml](render.yaml), see [Deployment](#deployment-bonus). Deployed link: **https://smart-city-portal-6g0t.onrender.com** (docs at `/docs`) |
| ✅ Bonus: `.env` secrets and secure access patterns | [.env.example](.env.example), [src/config.js](src/config.js), see [Security patterns](#security-patterns) |

---

## Architecture

```
                  Client (browser, Postman, mobile app)
                                    │  HTTPS + x-api-key + Authorization: Bearer <JWT>
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ API GATEWAY  (Express, public port 8080 / $PORT)                         │
│ request ID → security headers → API key check → rate limit → route       │
│ /docs  /redoc  /openapi.json  /health   (public, no API key)             │
└──────┬────────────────────────────┬─────────────────────────────┬────────┘
       │ /api/users/*               │ /api/complaints/*           │ /api/maps/*
       ▼                            ▼                             ▼
┌──────────────┐  /internal  ┌──────────────────┐         ┌──────────────────┐
│ USER SERVICE │◄────────────│ COMPLAINT SERVICE│         │ GEO SERVICE      │
│ :4001        │ service key │ :4002            │         │ :4003            │
│ login, JWT,  │             │ status workflow, │         │ geocode, reverse,│
│ roles        │             │ nearby search    │         │ distance         │
└──────────────┘             └────┬────────┬────┘         └───────┬──────────┘
                                  │ SMS    │ geocode              │
                                  ▼        ▼                      ▼
                        ┌────────────┐  ┌───────────────────────────────┐
                        │ SMS        │  │ GEOCODER                      │
                        │ Twilio or  │  │ OpenStreetMap Nominatim,      │
                        │ mock stub  │  │ Google Maps, or mock          │
                        └────────────┘  └───────────────────────────────┘
```

- Each service is a **separate Express app on its own port** and owns its own data.
- The internal services listen only on `127.0.0.1`. Only the gateway is reachable from outside.
- `start-all.js` runs all four apps in one Node process. That keeps local development to one command and deployment to one free Render service.
- The JWT is issued by the user service and **verified independently by every service** with the shared secret.

### Project structure

```
smart-city-portal/
├── docs/openapi.yaml           OpenAPI 3 spec (served by the gateway)
├── src/
│   ├── start-all.js            starts services + gateway
│   ├── config.js               reads .env, validates secrets, fails fast
│   ├── gateway/gateway.js      routing, API keys, rate limiting, docs
│   ├── services/               user-service, complaint-service, geo-service
│   ├── integrations/           geocoder.js (OSM/Google/mock), sms.js (Twilio/mock)
│   └── lib/                    JWT auth + roles, errors, validation, haversine
├── test/                       Mocha + Chai + Supertest (5 flows, 38 tests)
├── scripts/demo.js             scripted walkthrough for screenshots
├── render.yaml                 Render deployment blueprint
└── .env.example                every setting, with comments
```

---

## Running it locally

Requires **Node.js 20 or newer**.

```bash
cd "SGA-2/smart-city-portal"
npm install
cp .env.example .env      # then replace every "replace-with-..." value
npm start
```

A ready-to-use `.env` with random secrets has already been generated on this machine. It is git-ignored, so it never gets committed.

Then open:

| URL | What |
|---|---|
| http://localhost:8080/docs | Swagger UI. Click **Authorize** and enter the API key (and a JWT for user routes) |
| http://localhost:8080/redoc | ReDoc view of the same spec |
| http://localhost:8080/health | Health of the gateway and all three services |

The API key is the value of `API_KEYS` in `.env`. The admin login is `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

### Example requests

```bash
KEY=<your API key>; B=http://localhost:8080

# Log in, then store the JWT
TOKEN=$(curl -s -X POST $B/api/users/login -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"email":"admin@smartcity.local","password":"<ADMIN_PASSWORD>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# Create a complaint: the address is geocoded through OpenStreetMap
curl -s -X POST $B/api/complaints -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Large pothole near metro","description":"Deep pothole in the left lane.","category":"pothole","address":"MG Road, Bengaluru"}'

# Complaints within 3 km of an address (or use ?lat=12.97&lng=77.59)
curl -s "$B/api/complaints/nearby?address=Cubbon%20Park,%20Bengaluru&radiusKm=3" -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN"

# Change status (officer/admin): this sends an SMS to the citizen
curl -s -X PATCH $B/api/complaints/<id>/status -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"status":"in_progress","note":"Crew assigned"}'
```

### Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/users/register` | anyone | Create a citizen account (returns a JWT) |
| POST | `/api/users/login` | anyone | Log in, get a JWT |
| GET | `/api/users/me` | logged in | Own profile |
| GET | `/api/users` | admin | List users |
| PATCH | `/api/users/{id}/role` | admin | Make someone an officer/admin |
| POST | `/api/complaints` | logged in | Create a complaint (address is geocoded) |
| GET | `/api/complaints` | logged in | Citizens: own complaints. Staff: all. Filters: `status`, `category` |
| GET | `/api/complaints/nearby` | logged in | Complaints within `radiusKm` of `lat`/`lng` or an `address` |
| GET | `/api/complaints/{id}` | owner / staff | One complaint with its status history |
| PATCH | `/api/complaints/{id}/status` | officer, admin | Change status and SMS the citizen |
| DELETE | `/api/complaints/{id}` | admin | Delete |
| GET | `/api/complaints/notifications` | admin | SMS log (masked numbers) |
| GET | `/api/maps/geocode?address=` | logged in | Address → lat/lng |
| GET | `/api/maps/reverse?lat=&lng=` | logged in | lat/lng → address |
| GET | `/api/maps/distance?from=&to=` | logged in | Distance in km between two places |

Every `/api/*` request also needs the `x-api-key` header.

---

## Third-party integrations

### Geolocation: OpenStreetMap (default) or Google Maps

The provider is set with `GEOCODER_PROVIDER`.

- **`nominatim`** (default) uses OpenStreetMap's free geocoder and needs no account. The client follows the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/):
  - It sends an identifying `User-Agent`.
  - Requests are queued to **at most 1 per second**.
  - Results are **cached**, so repeated addresses don't call the API again.
  - Results are limited to India with `GEOCODER_COUNTRY_CODES=in`.
- **`google`** uses the Google Maps Geocoding API. Set `GOOGLE_MAPS_API_KEY`.
- **`mock`** uses a fixed table of Bengaluru, Delhi and Mumbai places, for offline work.
- **Coordinates:** an address written as `"12.97,77.59"` is used directly, with no external call.

**Nearby search** measures straight-line distance with the **haversine formula** and returns complaints within `radiusKm` (0.1–50 km, default 2), nearest first. It returns only public fields: the reporter's identity isn't shown.

**Error handling:**

| Situation | Response |
|---|---|
| Unknown address | `422 ADDRESS_NOT_FOUND` |
| Provider down or timed out (8 s limit) | `502 GEOCODER_UNAVAILABLE` |

### SMS on status change: mock stub (default) or Twilio sandbox

The provider is set with `SMS_PROVIDER`.

- **`mock`** "sends" by writing a log line with the phone number masked (`+91******3210`). Nothing leaves the machine.
- **`twilio`** calls Twilio's REST API directly with `fetch`, so no SDK is needed. For a free sandbox, use the **test credentials** from Twilio Console → Account → API keys & tokens, with `TWILIO_FROM_NUMBER=+15005550006`. Twilio then accepts the request but never delivers a real SMS.

Every status change triggers an SMS to the citizen who raised the complaint. The complaint service looks up the phone number from the user service through the protected `/internal` route. **A failed SMS never undoes the status change.** The failure is recorded in `GET /api/complaints/notifications` with `status: "failed"` and the provider's error.

---

## API gateway

[src/gateway/gateway.js](src/gateway/gateway.js) is built with Express and `http-proxy-middleware`.

| Feature | Details |
|---|---|
| Routing | `/api/users/*` → user service, `/api/complaints/*` → complaint service, `/api/maps/*` → geo service. Responses carry `x-served-by: <service>`. |
| API key verification | `x-api-key` header. Missing → `401 API_KEY_MISSING`; wrong → `403 API_KEY_INVALID`. Keys come from `API_KEYS`, can be comma-separated (one per client app), and are compared in constant time. |
| Rate limiting | 100 requests/min **per API key** for everything, and 10/min **per IP** for login and register (brute-force protection). Uses the IETF `RateLimit` headers. Over the limit → `429 RATE_LIMITED` with `Retry-After`. All limits are configurable. |
| Request tracing | Every request gets an `x-request-id`, which is forwarded to the services and returned in errors. |
| Hiding internals | The API key is **removed** before forwarding. `/internal/*` service routes are never routed (they return 404). Services listen on localhost only. |
| Resilience | A service that's down → `502 SERVICE_UNAVAILABLE`. `/health` reports each service and returns `503` if any is down. |
| Docs | Serves Swagger UI, ReDoc and the raw spec without needing an API key. |

---

## Swagger / OpenAPI documentation

[docs/openapi.yaml](docs/openapi.yaml) is an OpenAPI 3.0 spec covering all 15 API endpoints, plus `/health`. It includes:
- **request and response models**: 20 schemas, such as `Complaint`, `Location` and `Error`;
- **authentication**: two security schemes, `ApiKeyAuth` (gateway) and `BearerAuth` (JWT), with the role required for each endpoint;
- **examples** for every request body;
- **error responses**: 400, 401 (missing, invalid or expired token), 403, 404, 409, 422, 429 and 502, each with an example;
- the roles table, the rate limits and the common error format, in the description.

It is served at `/docs` (Swagger UI, with **Try it out** and a persisted **Authorize** button), `/redoc`, `/openapi.json` and `/openapi.yaml`.

---

## Automated tests

```bash
npm test
```

The suite uses **Mocha** and **Chai**, with **Supertest** to make the HTTP calls.

**How the tests run:**
- Each test file starts its own isolated copy of the system on random ports: the three services, the gateway, and fake OpenStreetMap and Twilio servers.
- All requests go through the gateway, just like a real client.
- The real integration code makes real HTTP calls to the fakes, so the tests need no internet connection or accounts.
- Nothing from your `.env` is used.

| Flow | File | What it proves |
|---|---|---|
| 1. Login + JWT verification | [test/1-auth.test.js](test/1-auth.test.js) | <ul><li>Register and login return a valid HS256 JWT (correct `sub`, `role` and 1-hour expiry).</li><li>The token works on protected routes.</li><li>Wrong password, no token, tampered token, a token signed with another secret, and an expired token are all rejected with `401`.</li><li>Self-assigning `admin` is ignored.</li><li>Invalid input → `400`; duplicate email → `409`.</li></ul> |
| 2. Complaint creation and status change | [test/2-complaints.test.js](test/2-complaints.test.js) | <ul><li>Complaints are created with geocoded lat/lng.</li><li>Field validation works.</li><li>open → in_progress → resolved by an officer, with an **SMS sent each time** (the payload checked at the fake Twilio).</li><li>Illegal transitions → `409`.</li><li>Citizens see only their own complaints.</li></ul> |
| 3. Role-based access failure | [test/3-rbac.test.js](test/3-rbac.test.js) | <ul><li>A citizen or officer **deleting** a complaint → `403`, and the complaint stays.</li><li>A citizen changing status → `403`, and no SMS is sent.</li><li>A citizen viewing someone else's complaint → `403`.</li><li>Admin-only user routes are blocked for others.</li><li>An admin delete → `204`, then `404`.</li></ul> |
| 4. External API integrations (mocked) | [test/4-integrations.test.js](test/4-integrations.test.js) | <ul><li>The geocoding request uses the right query, User-Agent and country filter, and results are cached.</li><li>Reverse geocoding works.</li><li>Unknown address → `422`; provider down or unreachable → `502`.</li><li>Distance is calculated correctly.</li><li>**Nearby search** returns only complaints within the radius, sorted by distance.</li><li>An SMS failure keeps the status change and logs the Twilio error.</li><li>The mock SMS provider masks numbers.</li></ul> |
| 5. API gateway | [test/5-gateway.test.js](test/5-gateway.test.js) | <ul><li>API key missing → `401`; invalid → `403`.</li><li>Each prefix routes to the right service.</li><li>`/internal` is not exposed.</li><li>Health and docs are public.</li><li>A downstream service that's down → `502`.</li><li>The API key is stripped and the request ID forwarded.</li><li>**Rate limiting** → `429` with `Retry-After`.</li><li>The stricter login limit works.</li></ul> |

Latest run: **38 passing** ([docs/test-output.txt](docs/test-output.txt)).

---

## Deployment (bonus)

The repository includes a Render Blueprint, [render.yaml](render.yaml). To deploy:

1. Push the `smart-city-portal` folder to a GitHub repository. `.gitignore` already excludes `.env` and `node_modules`.
2. On [render.com](https://render.com), go to **New → Blueprint** and select the repository.
3. Render generates `JWT_SECRET`, `INTERNAL_SERVICE_KEY` and `API_KEYS` automatically. Enter an `ADMIN_PASSWORD` when it asks.
4. After the first deploy, find the generated **API_KEYS** value under **Environment**. That is the key clients send.
5. Open `https://<your-app>.onrender.com/docs`, or run the demo against the deployment:
   `BASE_URL=https://<your-app>.onrender.com API_KEYS=<key> ADMIN_EMAIL=admin@smartcity.local ADMIN_PASSWORD=<pw> npm run demo`

**On Railway or Heroku:**
- Set the same environment variables in the dashboard.
- The start command is `npm start`.
- The platform sets `PORT` automatically.
- Set `TRUST_PROXY` to the number of proxies in front of the app (usually `1` on Railway/Heroku).

**Why `TRUST_PROXY=3` on Render:** Render puts three proxies in front of the app (Cloudflare, a load balancer and an internal ingress). With fewer hops trusted, the app sees a proxy address instead of the client, and the per-IP login limit splits across several addresses. With `3`, every request from one client has the same rate-limit key, and a fake `X-Forwarded-For` header sent by the client cannot change it. This was checked on the live deployment.

**Free-tier notes:**
- Render's free service sleeps after inactivity, so the first request can take about 30 seconds.
- Data is held in memory, so it resets whenever the service restarts. The seeded admin account is recreated each time.

---

## Security patterns

| Area | Measures |
|---|---|
| **Secrets** | <ul><li>Every secret is read from the environment ([src/config.js](src/config.js)).</li><li>`.env` is git-ignored, and `.env.example` documents each variable.</li><li>On Render, secrets are generated or entered in the dashboard.</li><li>The app **refuses to start** if `JWT_SECRET` is missing or shorter than 32 characters, or if `INTERNAL_SERVICE_KEY` or `API_KEYS` is missing.</li></ul> |
| **Passwords** | <ul><li>Hashed with bcrypt.</li><li>Login returns the same message for an unknown email and a wrong password, and compares against a dummy hash, so response times don't reveal which emails exist.</li></ul> |
| **JWT** | <ul><li>Signed with HS256, with the algorithm pinned on verify.</li><li>Issuer checked; 1-hour expiry.</li><li>The role is taken from the signed token and never from the request body.</li></ul> |
| **Two-layer authentication** | <ul><li>The API key identifies the client app and is checked at the gateway.</li><li>The JWT identifies the user and is checked by each service.</li><li>Role checks (`requireRole`) run on every protected route.</li></ul> |
| **API keys** | <ul><li>Compared in constant time.</li><li>Never forwarded to services.</li><li>The rate limiter stores only a SHA-256 fingerprint, not the raw key.</li></ul> |
| **Service-to-service calls** | <ul><li>`/internal/*` routes need a separate `INTERNAL_SERVICE_KEY` and aren't routed by the gateway.</li><li>Services bind to localhost only.</li></ul> |
| **HTTP hardening** | <ul><li>Helmet security headers and a CORS allow-list (`CORS_ORIGINS`).</li><li>100 KB body limit.</li><li>Errors never include stack traces.</li><li>`trust proxy` is configurable, so rate limits apply to the real client IP behind Render.</li></ul> |
| **Personal data** | <ul><li>Phone numbers are masked in logs and in the SMS log.</li><li>Nearby search hides who reported each complaint.</li></ul> |

---

## Screenshots to capture

Start the app (`npm start`) and capture:

1. **Swagger UI** at `/docs`: the endpoint list, the **Authorize** dialog with both schemes, and one expanded endpoint showing its schema and error examples.
2. **Try it out** in Swagger: `POST /api/complaints` returning `201` with the OpenStreetMap `location`.
3. **`npm run demo`** in the terminal, split across two or three screenshots. It shows:
   - geocoding;
   - three complaints with their coordinates;
   - the nearby search with distances;
   - the 403 role check;
   - the status update with the SMS notification;
   - the SMS log.
4. **The server terminal**, showing the `[sms:mock] to=+91******3210 ...` line and the gateway → service log lines.
5. **`npm test`** with **38 passing**.
6. *(If deployed)* the Render dashboard and `/docs` on the live URL.

For a screencast, record steps 1–5 in about 2 minutes.

---

## Notes

- **Storage:** data is kept in memory so the project runs with no database setup. Each service owns its own store, so a real database (such as Part 1's) can replace one service at a time without touching the gateway.
- **Folder name and npm:** the parent folder name `BITS_Backend:API Dev` contains a `:`. npm uses `:` to separate PATH entries, so `npx mocha` can't find mocha there. `npm test` calls Mocha through `node` and works anyway.
