"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { refreshAuthSession } from "@/components/auth/useAuthSession";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { safeAuthRedirect } from "@/lib/authRedirect";
import { resendEmailVerification, signUpWithPassword } from "@/app/actions/auth";
import { GoogleMark } from "@/components/auth/GoogleMark";
import { SignInCodeStep } from "@/components/auth/SignInCodeStep";
import { deviceId, useAutofillSync } from "@/components/auth/signInBrowser";

type Mode = "signin" | "signup";

export function LoginForm({ accountCreationEnabled, googleSsoConfigured }: { accountCreationEnabled: boolean; googleSsoConfigured: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const callbackUrl = useMemo(() => {
    return safeAuthRedirect(sp.get("callbackUrl"));
  }, [sp]);

  const [mode, setMode] = useState<Mode>(() =>
    accountCreationEnabled && sp.get("error") === "google_account_required" ? "signup" : "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeRequired, setEmailCodeRequired] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(() =>
    sp.get("verified") === "1" ? "Email verified. You can now sign in." : null,
  );
  const [error, setError] = useState<string | null>(() => {
    const errorCode = sp.get("error");
    if (errorCode === "google_account_required") return "Create an account with your email and password before continuing with Google.";
    if (errorCode === "account_creation_disabled") return "New account creation is currently unavailable. Ask an administrator for access or sign in with an existing account.";
    return errorCode ? "Sign-in could not be completed. Try again, or use your password and verify your email first." : null;
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [needsEmailVerification, setNeedsEmailVerification] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const currentCredentials = useCallback(() => {
    const currentEmail = emailInputRef.current?.value ?? email;
    const currentPassword = passwordInputRef.current?.value ?? password;
    if (currentEmail !== email) setEmail(currentEmail);
    if (currentPassword !== password) setPassword(currentPassword);
    return { email: currentEmail, password: currentPassword };
  }, [email, password]);

  useAutofillSync(currentCredentials);

  function resetStatus() {
    setError(null);
    setMessage(null);
    setFieldErrors({});
  }

  function resetMfaChallenge() {
    setMfaRequired(false);
    setTotp("");
    setEmailCodeRequired(false);
    setEmailCode("");
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    resetStatus();
    setLoading("credentials");
    const credentials = currentCredentials();
    let r;
    try {
      r = await signIn("credentials", {
        email: credentials.email,
        password: credentials.password,
        totp,
        emailCode,
        device: deviceId(),
        redirect: false,
      });
    } catch {
      setLoading(null);
      setError("Sign-in is temporarily unavailable. Please refresh the page and try again.");
      return;
    }
    setLoading(null);
    if (!r) {
      setError("Unexpected error. Please try again.");
      return;
    }
    if (r.error) {
      if (r.code === "mfa_required") {
        setMfaRequired(true);
        return;
      }
      if (r.code === "email_code_required") {
        setEmailCodeRequired(true);
        setEmailCode("");
        return;
      }
      if (r.code === "too_many_attempts") {
        setError("Too many unsuccessful sign-ins. Wait an hour and try again, or reset your password.");
        return;
      }
      if (r.code === "email_verification_required") {
        setNeedsEmailVerification(true);
        setMessage("Verify your email before signing in. You can request a new link below.");
        return;
      }
      setError(emailCodeRequired ? "That code isn't right, or it has expired." : mfaRequired ? "Invalid authenticator or recovery code." : "Invalid email or password.");
      return;
    }
    // Client chrome reads the session from a store; refresh it for the next page.
    void refreshAuthSession();
    router.push(callbackUrl);
    router.refresh();
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    resetStatus();
    setLoading("signup");
    let res;
    try {
      res = await signUpWithPassword({ name, email, password });
    } catch {
      setLoading(null);
      setError("Account creation is temporarily unavailable. Please try again.");
      return;
    }
    if (!res.ok) {
      setError(res.error);
      setFieldErrors(res.fieldErrors ?? {});
      setLoading(null);
      return;
    }
    setLoading(null);
    setNeedsEmailVerification(true);
    setMessage("If this email can be registered, check your inbox for a verification link. Otherwise, sign in or reset your password.");
    setMode("signin");
    setPassword("");
  }

  async function handleResendVerification() {
    resetStatus();
    setLoading("resend-verification");
    let result;
    try {
      result = await resendEmailVerification({ email });
    } catch {
      setLoading(null);
      setError("Email delivery is temporarily unavailable. Please try again.");
      return;
    }
    setLoading(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMessage("If that account needs verification, a new link has been sent.");
  }

  const isSignUp = mode === "signup";

  const backToStart = () => {
    resetMfaChallenge();
    resetStatus();
  };

  if (emailCodeRequired) {
    return (
      <SignInCodeStep
        title="Check your email"
        description={`This sign-in looks new, so we emailed a six-digit code to ${email}. It expires in 10 minutes.`}
        label="Code from the email"
        value={emailCode}
        onChange={setEmailCode}
        numeric
        error={error}
        loading={loading === "credentials"}
        onSubmit={handleSignIn}
        onBack={backToStart}
      />
    );
  }

  if (mfaRequired) {
    return (
      <SignInCodeStep
        title="Verify it's you"
        description={`Enter the code from your authenticator app for ${email}.`}
        label="Authenticator or recovery code"
        helperText="Use a six-digit authenticator code or a recovery code."
        value={totp}
        onChange={setTotp}
        error={error}
        loading={loading === "credentials"}
        onSubmit={handleSignIn}
        onBack={backToStart}
      />
    );
  }

  const switchMode = (next: Mode) => {
    setMode(next);
    resetStatus();
    resetMfaChallenge();
    setNeedsEmailVerification(false);
  };

  return (
    <Tabs value={mode} onValueChange={(value) => switchMode(value as Mode)} className="flex flex-col gap-4">
      <TabsList aria-label="Sign in or create an account" className="grid auto-cols-fr grid-flow-col gap-1 rounded-full border border-line bg-surface p-1">
        <TabsTrigger value="signin" className="min-h-10 justify-center rounded-full px-4 after:hidden border border-transparent data-[state=active]:border-line-strong data-[state=active]:bg-panel data-[state=active]:font-semibold">Sign in</TabsTrigger>
        {accountCreationEnabled ? <TabsTrigger value="signup" className="min-h-10 justify-center rounded-full px-4 after:hidden border border-transparent data-[state=active]:border-line-strong data-[state=active]:bg-panel data-[state=active]:font-semibold">Create account</TabsTrigger> : null}
      </TabsList>

      <TabsContent value={mode} className="flex flex-col gap-4 pt-0">
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
        {message ? <Callout tone="success" role="status">{message}</Callout> : null}

        {needsEmailVerification ? (
          <Button variant="secondary" className="self-start" disabled={!!loading || !email} onClick={handleResendVerification}>
            {loading === "resend-verification" ? "Sending…" : "Resend verification email"}
          </Button>
        ) : null}

        {googleSsoConfigured ? (
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            disabled={!!loading}
            onClick={() => {
              resetStatus();
              setLoading("google");
              void signIn("google", { callbackUrl }).catch(() => {
                setLoading(null);
                setError("Google sign-in is temporarily unavailable. Please try again.");
              });
            }}
          >
            <GoogleMark />
            Continue with Google
          </Button>
        ) : (
          <Callout tone="info">Google sign-in is not configured for this instance.</Callout>
        )}

        <div className="flex items-center gap-3 text-sm text-ink-muted">
          <span aria-hidden className="h-px flex-1 bg-line" />
          or with email
          <span aria-hidden className="h-px flex-1 bg-line" />
        </div>

        <form className="flex flex-col gap-4" onSubmit={isSignUp ? handleSignUp : handleSignIn}>
          {isSignUp ? (
            <Field label="Name" required error={fieldErrors.name?.[0]}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </Field>
          ) : null}
          <Field label="Email" required error={fieldErrors.email?.[0]}>
            <Input
              ref={emailInputRef}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                resetMfaChallenge();
              }}
              autoComplete="email"
            />
          </Field>
          <div className="relative">
            <Field label="Password" required error={fieldErrors.password?.[0]} helperText={isSignUp ? "At least 12 characters." : undefined}>
              <PasswordInput
                ref={passwordInputRef}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  resetMfaChallenge();
                }}
                autoComplete={isSignUp ? "new-password" : "current-password"}
                minLength={isSignUp ? 12 : undefined}
                maxLength={128}
              />
            </Field>
            {!isSignUp ? (
              <Link href="/reset-password" className="absolute right-0 top-0 text-sm font-semibold text-ink-secondary underline underline-offset-4 hover:text-ink">
                Forgot password?
              </Link>
            ) : null}
          </div>
          <Button type="submit" variant="primary" size="lg" fullWidth disabled={!!loading} className="mt-1">
            {isSignUp
              ? loading === "signup"
                ? "Creating account…"
                : "Create account"
              : loading === "credentials"
                ? "Signing in…"
                : "Sign in"}
          </Button>
        </form>

        {accountCreationEnabled ? (
          <button
            type="button"
            onClick={() => switchMode(isSignUp ? "signin" : "signup")}
            className="self-center text-sm text-ink-secondary underline-offset-4 hover:text-ink hover:underline"
          >
            {isSignUp ? "Already have an account? Sign in" : "Don't have an account? Create one"}
          </button>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
