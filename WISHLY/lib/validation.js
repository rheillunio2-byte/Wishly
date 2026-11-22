// Input validation for auth routes. Kept free of Express/DB imports so it can be unit-tested on its own.
// NOTE: the email pattern must use single backslashes (\S, \.). The previous inline version used
// "\\S" inside a regex literal, which matches a literal backslash and rejected every real email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateSignup(body) {
  const name = String(body?.name ?? "").trim().replace(/\s+/g, " ");
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (name.length < 2) return { error: "Enter your name (at least 2 characters).", field: "name" };
  if (name.length > 80) return { error: "That name is a bit long. Please use 80 characters or fewer.", field: "name" };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { error: "Enter a valid email address, like you@example.com.", field: "email" };
  if (password.length < 8) return { error: "Choose a password with at least 8 characters.", field: "password" };
  // bcrypt only uses the first 72 bytes; reject longer input instead of silently truncating it.
  if (Buffer.byteLength(password, "utf8") > 72) return { error: "Passwords can be at most 72 characters.", field: "password" };
  return { value: { name, email, password } };
}

module.exports = { EMAIL_RE, validateSignup };
