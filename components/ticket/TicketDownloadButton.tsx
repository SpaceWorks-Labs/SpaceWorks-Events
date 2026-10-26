import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Save the ticket as an image, with a PDF beside it (docs/TICKET_DESIGNER.md). */
export function TicketDownloadButton(props: { downloadUrl: string; pdfUrl?: string; }) {
  return (
    <div className="flex flex-col gap-1">
      <Button asChild variant="secondary" size="lg" fullWidth>
        <a href={props.downloadUrl} download>
          <Download aria-hidden className="size-[18px] shrink-0" />
          Save ticket
        </a>
      </Button>
      {props.pdfUrl ? <a href={props.pdfUrl} download className="text-center text-caption font-semibold text-ink-secondary underline underline-offset-4 hover:text-ink">PDF</a> : null}
    </div>
  );
}
