import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/* Panel: a box whose title sits in the top border, like ┌─ TITLE ─── */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  accent = "amber",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  accent?: "amber" | "phos" | "err";
}) {
  const accentText = { amber: "text-amber", phos: "text-phos", err: "text-err" }[accent];
  return (
    <section
      className={cn(
        "group/panel relative border border-line bg-panel/80 backdrop-blur-[1px] transition-colors duration-300 hover:border-line-2",
        className,
      )}
    >
      <Corners />
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-dashed border-line px-3 py-1.5">
          <h2 className={cn("truncate text-[11px] uppercase tracking-[0.18em]", accentText)}>
            <span className="text-amber-dim">┌─ </span>
            {title}
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

function Corners() {
  const c = "pointer-events-none absolute size-2 border-amber opacity-0 transition-opacity duration-300 group-hover/panel:opacity-100";
  return (
    <>
      <span className={cn(c, "-left-px -top-px border-l border-t")} />
      <span className={cn(c, "-right-px -top-px border-r border-t")} />
      <span className={cn(c, "-bottom-px -left-px border-b border-l")} />
      <span className={cn(c, "-bottom-px -right-px border-b border-r")} />
    </>
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "ghost" | "danger" | "phos";
  size?: "sm" | "md";
};

function buttonClass(variant: NonNullable<ButtonProps["variant"]>, size: NonNullable<ButtonProps["size"]>, className?: string) {
  const variants = {
    primary: "border-amber bg-amber/10 text-amber hover:bg-amber hover:text-bg hover:shadow-[0_0_18px_rgb(255_176_0/0.45)]",
    ghost: "border-line-2 text-fg hover:border-amber hover:text-amber",
    danger: "border-err/60 text-err hover:bg-err hover:text-bg hover:shadow-[0_0_18px_rgb(255_77_61/0.45)]",
    phos: "border-phos/60 text-phos hover:bg-phos hover:text-bg hover:shadow-[0_0_18px_rgb(57_255_122/0.4)]",
  };
  const sizes = { sm: "h-7 px-2 text-[11px]", md: "h-9 px-3 text-xs" };
  return cn(
    "press group/btn inline-flex cursor-pointer select-none items-center justify-center gap-2 border uppercase tracking-[0.14em] transition-all duration-150",
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit disabled:hover:shadow-none",
    variants[variant],
    sizes[size],
    className,
  );
}

function Brackets({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="text-amber-dim transition-transform duration-150 group-hover/btn:-translate-x-0.5 group-disabled/btn:translate-x-0">[</span>
      {children}
      <span className="text-amber-dim transition-transform duration-150 group-hover/btn:translate-x-0.5 group-disabled/btn:translate-x-0">]</span>
    </>
  );
}

export function Button({ variant = "ghost", size = "md", className, children, ...rest }: ButtonProps) {
  return (
    <button className={buttonClass(variant, size, className)} {...rest}>
      <Brackets>{children}</Brackets>
    </button>
  );
}

export function ButtonLink({
  variant = "ghost",
  size = "md",
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & Pick<ButtonProps, "variant" | "size">) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      <Brackets>{children}</Brackets>
    </Link>
  );
}

const fieldBase =
  "w-full border border-line bg-bg-2 px-2.5 py-1.5 text-fg placeholder:text-amber-faint outline-none transition-all duration-150 focus:border-amber focus:bg-bg focus:shadow-[0_0_0_1px_rgb(255_176_0/0.25),0_0_14px_rgb(255_176_0/0.15)] disabled:opacity-50";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cn(fieldBase, "h-9", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cn(fieldBase, "min-h-24 resize-y leading-relaxed", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <select className={cn(fieldBase, "h-9 cursor-pointer appearance-none bg-[length:10px] pr-7", className)} {...rest}>
      {children}
    </select>
  );
}

export function Label({ children, hint, className }: { children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <span className={cn("mb-1 flex items-baseline justify-between gap-2 text-[11px] uppercase tracking-[0.16em] text-muted", className)}>
      <span>
        <span className="text-amber-dim">$ </span>
        {children}
      </span>
      {hint && <span className="normal-case tracking-normal text-amber-faint">{hint}</span>}
    </span>
  );
}

// `label` overrides the spoken text for a dot that does not mean presence — an attached
// agent is "reachable", never "online", and a screen reader saying otherwise is the same
// mistake the devices list used to make visually.
export function Led({ on, tone, label, className }: { on: boolean; tone?: "phos" | "amber" | "err"; label?: string; className?: string }) {
  const t = tone ?? (on ? "phos" : "amber");
  const color = { phos: "text-phos bg-phos", amber: "text-amber-faint bg-amber-faint", err: "text-err bg-err" }[t];
  return (
    <span
      aria-label={label ?? (on ? "online" : "offline")}
      className={cn("inline-block size-2 shrink-0 rounded-full", color, on && "animate-breathe", className)}
    />
  );
}

export function Tag({ children, tone = "amber", className }: { children: ReactNode; tone?: "amber" | "phos" | "err" | "warn" | "info" | "muted"; className?: string }) {
  const tones = {
    amber: "text-amber border-amber/40",
    phos: "text-phos border-phos/40",
    err: "text-err border-err/50",
    warn: "text-warn border-warn/40",
    info: "text-info border-info/40",
    muted: "text-muted border-line-2",
  };
  return (
    <span className={cn("inline-flex h-5 items-center border px-1.5 text-[10px] uppercase leading-none tracking-[0.12em]", tones[tone], className)}>
      {children}
    </span>
  );
}

// Marks UI that exists ahead of its backend.
export function NotWired({ className }: { className?: string }) {
  return (
    <span title="UI only: not wired to a backend yet" className={cn("text-[10px] uppercase tracking-[0.14em] text-amber-faint", className)}>
      [offline]
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="border border-line-2 bg-bg-2 px-1 text-[10px] text-muted">{children}</kbd>;
}

const ART = String.raw`
   .--------------.
   | >_           |
   |              |
   '--------------'
      _|______|_
`;

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <pre className="font-mono text-[11px] leading-tight text-amber-faint">{ART}</pre>
      <p className="text-amber glow">{title}</p>
      {children && <div className="max-w-sm text-xs text-muted">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-4xl leading-none text-amber glow">
          <span className="text-amber-dim">&gt; </span>
          {title}
          <span className="cursor" />
        </h1>
        {subtitle && <p className="mt-1 text-xs text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
