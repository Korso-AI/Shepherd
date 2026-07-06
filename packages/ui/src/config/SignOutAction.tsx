import { useId } from "react";

/** Props for the hosted session sign out presentation control. */
export interface SignOutActionProps {
  /** Called immediately when the operator chooses to end this dashboard session. */
  onLogout: () => void;
}

/** Renders the session-level sign out control supplied by the host shell. */
export function SignOutAction({ onLogout }: SignOutActionProps) {
  const headingId = useId();

  return (
    <section className="config-signout" aria-labelledby={headingId}>
      <div className="card-head">
        <h3 id={headingId}>Session</h3>
      </div>
      <div className="card-body">
        <p className="helper">Sign out of this Shepherd dashboard session.</p>
        <button type="button" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </section>
  );
}
