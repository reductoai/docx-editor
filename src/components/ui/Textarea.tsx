import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full resize-none border-0 bg-transparent outline-none font-sans text-[13px] leading-[1.5] text-fg-primary placeholder:text-fg-secondary",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export default Textarea;
