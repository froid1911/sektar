// A settings tab that is a link: picking it opens a drive's own page (its drive
// app), not a page inside Settings. Connect's settings tabs are routes rendered
// in the settings page, so the tab's route forwards to the drive at once.
import { useDrives } from "@powerhousedao/reactor-browser";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { findDrive } from "../../../../processors/drive-ids/index.js";

export function OpenDrive({ slug, label }: { slug: string; label: string }) {
  const drives = useDrives();
  const navigate = useNavigate();
  // The converted drive where this store has it, else the one under the slug
  const drive = findDrive(drives, slug);
  useEffect(() => {
    if (!drive) return;
    void navigate({
      to: "/d/$driveSlug/{-$nodeSlug}",
      params: { driveSlug: drive.header.id },
      replace: true,
    });
  }, [drive, navigate]);
  return (
    <p className="sk-text-muted">
      {drive ? `Opening ${label}…` : "Connecting…"}
    </p>
  );
}
