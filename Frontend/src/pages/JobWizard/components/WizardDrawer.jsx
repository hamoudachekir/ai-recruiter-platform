import PropTypes from 'prop-types';
import * as Dialog from '@radix-ui/react-dialog';
import JobWizard from '../JobWizard';

/**
 * Right-side slide-over drawer that hosts the JobWizard.
 *
 * Built on Radix Dialog (focus trap, ESC to close, scroll lock) with
 * tailwindcss-animate utilities for the slide and fade animations.
 *
 * The `[data-wizard-scope]` attribute is on both the overlay and the content
 * so the scoped Tailwind border/box-sizing defaults from src/index.css apply
 * inside the portaled DOM tree.
 */
export default function WizardDrawer({
  open,
  onOpenChange,
  entrepriseId,
  mode = 'new',
  jobId,
  onPublished,
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-wizard-scope
          className="
            fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm
            data-[state=open]:animate-in  data-[state=open]:fade-in-0
            data-[state=closed]:animate-out data-[state=closed]:fade-out-0
            duration-300
          "
        />
        <Dialog.Content
          data-wizard-scope
          aria-describedby={undefined}
          className="
            fixed right-0 top-0 bottom-0 z-[70]
            flex flex-col bg-[#0b0c2a]
            shadow-[-24px_0_60px_-15px_rgba(0,0,0,0.6)]
            ring-1 ring-[#36d1dc]/10
            w-full sm:w-[640px] md:w-[760px] lg:w-[920px] xl:w-[1040px]
            outline-none
            data-[state=open]:animate-in  data-[state=open]:slide-in-from-right
            data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right
            duration-300
          "
        >
          <Dialog.Title className="sr-only">Create a job</Dialog.Title>
          <JobWizard
            mode={mode}
            entrepriseId={entrepriseId}
            jobId={jobId}
            inDrawer
            onClose={() => onOpenChange(false)}
            onPublished={onPublished}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

WizardDrawer.propTypes = {
  open:         PropTypes.bool.isRequired,
  onOpenChange: PropTypes.func.isRequired,
  entrepriseId: PropTypes.string.isRequired,
  mode:         PropTypes.oneOf(['new', 'edit']),
  jobId:        PropTypes.string,
  onPublished:  PropTypes.func,
};
