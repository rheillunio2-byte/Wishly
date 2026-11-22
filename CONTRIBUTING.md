<div align="center">

<img src="images/wishly-banner.svg" alt="WISHLY: Big wishes. Kind strangers. Real moments." width="100%">

# Contributing to WISHLY

**Thank you for helping a small kindness travel further.**

<a href="#ground-rules">Ground rules</a> &nbsp;·&nbsp;
<a href="#set-up">Set up</a> &nbsp;·&nbsp;
<a href="#where-things-live">Where things live</a> &nbsp;·&nbsp;
<a href="#recipes">Recipes</a> &nbsp;·&nbsp;
<a href="#working-on-animations">Animations</a> &nbsp;·&nbsp;
<a href="#money-and-privacy-rules">Money rules</a> &nbsp;·&nbsp;
<a href="#pull-requests">Pull requests</a>

</div>

<img src="images/wishly-divider.svg" alt="" width="100%">

## Ground rules

- **Be kind.** WISHLY is about people helping people. Treat issues, reviews and discussions the same way.
- **Keep it small and readable.** The backend is deliberately one Express file and the front end has no build step. A change that adds a framework, a bundler or a heavy dependency needs a strong reason, discussed in an issue first.
- **Money and privacy come first.** Read [Money and privacy rules](#money-and-privacy-rules) before you touch payments, fees, bill details or user data.
- **Originality.** Only submit code you wrote or have the right to contribute. If you adapt something (for example an effect from a component library), say where it came from and make sure its license allows it.
- **One idea per pull request.** Small, focused changes are reviewed quickly.

> [!IMPORTANT]
> **Found a security problem?** Please do not open a public issue. Contact the maintainer privately, describe how to reproduce it, and give them time to fix it before sharing details. Never include real keys, real bill references or real user data in an issue.

<img src="images/wishly-divider.svg" alt="" width="100%">

## Set up

**You need:** Node.js **26 or newer** (WISHLY uses the built-in `node:sqlite`) and npm.

```bash
npm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
# edit .env and set a long random JWT_SECRET
npm run dev                   # http://localhost:4000
```

Account creation and browsing work with no PayMongo keys. Add **test** keys (`sk_test_...`) only if you are working on checkout, and never commit your `.env`.

**Handy commands**

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server with auto-restart (nodemon). |
| `npm start` | Starts the server once. |
| `npm run check` | Syntax-checks `server.js`. |
| `npm run smoke` | With the server running, checks health, the wish list, signup and login. Set `WISHLY_URL` to test another address. |

**Start from a clean database** by stopping the server and deleting `data/wishly.sqlite*`. It is recreated and re-seeded on the next start.

<img src="images/wishly-divider.svg" alt="" width="100%">

## Where things live

```text
WISHLY/
├── lib/validation.js        input validation, no Express or DB imports
├── public/
│   ├── index.html           all markup: auth screen, app pages, modal
│   ├── app.js               client logic
│   ├── styles.css           base theme and layout
│   ├── animations.css       motion, logo swapping, auth polish
│   ├── images/              logos, favicon, tile art
│   └── fx/                  drift-wall, crosshair, click-spark, init.js
├── scripts/smoke.js
└── server.js                API, schema, PayMongo, webhook
```

The split is on purpose: `lib/` knows nothing about HTTP, `public/` knows nothing about Node, and effects in `public/fx/` know nothing about WISHLY. Each effect takes an element and options, and returns `update()` and `destroy()`.

<img src="images/wishly-divider.svg" alt="" width="100%">

## Recipes

### Add a wish category

Categories appear in three places. Keep them in sync:

1. **`server.js`**: the allow-list in `POST /api/wishes`.
2. **`public/index.html`**: the `<select name="category">` on the create form and, if you want a tab, the buttons in `#homeFilters` and `#exploreFilters`.
3. **`public/images/tiles/`** *(optional)*: new placeholder art for the login wall, plus its entry in `public/fx/init.js`.

### Change signup rules

Edit **`lib/validation.js`** only, then mirror the same message in `validateAuth()` in `public/app.js` so the browser and server agree. Keep two things true:

- The email pattern uses single backslashes or character classes. A double-escaped pattern (`\\S` inside a regex literal) matches a literal backslash and rejects every real email. That exact mistake once made signup impossible.
- Passwords are limited to **72 bytes** because bcrypt ignores the rest.

### Add an API route

1. Validate input first and return `{ "error": "..." }` with a sensible status code (`400` input, `401` not signed in, `403` not allowed, `404` missing, `409` conflict).
2. Use prepared statements (`db.prepare(...).run(...)`). Never build SQL from user input.
3. Add `auth` (and `admin` where relevant) middleware.
4. Document it in the README's API table.
5. Return only the fields the client needs. Never return `password_hash`, bill references or other people's emails.

### Change the platform fee

Set `PLATFORM_FEE_PERCENT`. The UI copy currently says "1%" in several places (`index.html`, `app.js`, and the PayMongo `remarks` in `server.js`). If you change the number, update every mention so the interface never misstates the fee.

### Replace the placeholder tile art

Drop 600×400 images into `public/images/tiles/` and list them in `public/fx/init.js`. Real photos need permission to use, and wishers' photos should only appear with their consent.

<img src="images/wishly-divider.svg" alt="" width="100%">

## Working on animations

<div align="center">

<img src="images/wishly-login-effects.svg" alt="Illustration of the login screen with a drifting tile wall, a crosshair and a click burst." width="100%">

</div>

The login screen uses three effects (drift wall, crosshair, click spark) wired together in `public/fx/init.js`. Everything else is CSS in `public/animations.css`. Please follow these rules:

- **Respect reduced motion.** Anything that moves needs a `prefers-reduced-motion` path. `animations.css` has a global rule at the end, and each script checks `matchMedia` itself.
- **Decoration is not content.** Background effects get `aria-hidden="true"` and must never add tab stops. Test the login page with the keyboard only.
- **Animate cheaply.** Prefer `transform` and `opacity`. Avoid animating layout properties on lists.
- **Use `backwards`, not `both`, for entrance animations** on elements that also have hover transforms. A forwards fill freezes the final `transform` and silently disables the hover effect.
- **Clean up.** Every effect must remove its listeners, observers and animation frames in `destroy()`, and sleep while its container is hidden.
- **Keep effects portable.** Anything in `public/fx/` takes options and an element, and imports nothing from WISHLY.
- **Don't block input.** Effect layers use `pointer-events: none`.

**The logo** lives in `public/images/` as `logo.svg` (light backgrounds), `logo-light.svg` (dark backgrounds), `logo-mark.svg` (icon only) and `favicon.svg` (static). Keep the SVGs self-contained, with no external fonts or images, and keep the favicon free of animation.

<img src="images/wishly-divider.svg" alt="" width="100%">

## Money and privacy rules

This is the part where mistakes cost real people, so these are firm:

1. **Secrets stay on the server.** The PayMongo secret key and webhook secret never appear in `public/`, logs or error messages.
2. **A gift counts only after the webhook confirms it.** Never mark a contribution `paid` from a browser redirect.
3. **Keep the webhook safe.** Verify the signature against the raw body, compare in constant time, and keep it idempotent so a repeated delivery cannot add the same gift twice.
4. **Amounts are integers in centavos.** Do not introduce floating-point money in the database or in fee math.
5. **The fee is shown before it is charged**, and it is taken from the contribution, not added to it.
6. **Do not promise what the platform does not do.** The UI must not suggest automatic payouts, escrow or instant bill payment.
7. **Protect personal data.** Bill provider and reference are private. Do not expose them on public routes, add them to logs, or use real ones in tests, screenshots or issues.
8. **Test data only.** Use PayMongo test keys and obviously fake people and accounts.

<img src="images/wishly-divider.svg" alt="" width="100%">

## Pull requests

**Before you open one**

- [ ] `npm run check` passes.
- [ ] `npm run smoke` passes against a running server (including signup and login).
- [ ] You tried the change in the browser: desktop and a narrow phone width, light and dark.
- [ ] Animations still work with *reduce motion* switched on, and the login page works with the keyboard only.
- [ ] No secrets, `.env`, database files or real personal data are included.
- [ ] The README or this guide is updated if behaviour, routes or setup changed.

**In the description**, say what changed and why, how you tested it, and include before and after screenshots for visual changes. Link the issue if there is one.

**Commit messages** are short and in the imperative: `Fix signup email validation`, `Add Experiences filter tab`.

**Good first contributions:** improve error messages, add tests, tighten accessibility, polish mobile layouts, fix typos, or pick an item from the README roadmap.

<img src="images/wishly-divider.svg" alt="" width="100%">

<div align="center">

<img src="images/wishly-footer.svg" alt="WISHLY: make a wish a little closer." width="100%">

<sub>Thank you for making a wish a little closer.</sub>

</div>
