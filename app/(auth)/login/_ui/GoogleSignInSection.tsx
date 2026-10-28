"use client";

import type { Dispatch, SetStateAction } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { GoogleMark } from "@/components/auth/GoogleMark";

/** "Continue with Google" (or why it isn't offered), then the "or with email" divider. */
export function GoogleSignInSection({ googleSsoConfigured, loading, callbackUrl, resetStatus, setLoading, setError }: {
  googleSsoConfigured: boolean;
  loading: string | null;
  callbackUrl: string;
  resetStatus: () => void;
  setLoading: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  return (
    <>
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
    </>
  );
}
