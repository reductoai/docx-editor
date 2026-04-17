import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "icon";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center font-sans text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          variant === "default" && "bg-brand text-[color:var(--brand-fg)] rounded-md px-3 h-[26px] hover:bg-[color:var(--plum-900)]",
          variant === "ghost" && "rounded-md px-2 h-[26px] text-fg-secondary hover:bg-surface-hover",
          variant === "icon" && "h-6 w-6 rounded-md text-[color:var(--icon)] hover:bg-surface-hover hover:text-[color:var(--icon-hover)]",
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export default Button;
