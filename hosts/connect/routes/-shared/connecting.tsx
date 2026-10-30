/**
 * The drive has not reached this browser yet. It usually has a moment later,
 * so this says only that: a slow load never reads as a missing drive.
 */
export function Connecting() {
  return (
    <div className="sk-page sk-stack sk-stack--6">
      <div className="sk-small sk-text-muted" role="status">
        Connecting…
      </div>
    </div>
  );
}
