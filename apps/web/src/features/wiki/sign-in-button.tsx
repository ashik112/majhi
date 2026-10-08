import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

/** Starts the sign-in of an account: the Accounts page opens on it with the sign-in already going. */
export function SignInButton({ account, primary = false }: { account: string; primary?: boolean }) {
  return (
    <Button asChild size="sm" variant={primary ? "primary" : "secondary"}>
      <Link to="/accounts" search={{ account, signin: "start" }}>
        Sign in
      </Link>
    </Button>
  );
}
