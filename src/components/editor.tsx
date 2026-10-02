// Editor-specific composites built from the shadcn primitives in `components/ui/*`.
// Everything interactive here is a shadcn component; this file only adapts them to the
// small value/onChange APIs the editor panels use.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider as UiSlider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

export function IconButton({
  active,
  className,
  label,
  children,
  ...rest
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & { active?: boolean; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...rest}
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={active}
          className={cn("size-8 rounded-[10px]", active && "bg-foreground/10 text-foreground", className)}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-line">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  className,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  className?: string;
  label?: string;
}) {
  return (
    <UiSlider
      aria-label={label}
      className={className}
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={([v]) => onChange(v)}
      onValueCommit={() => onCommit?.()}
    />
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
  disabled,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  className?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <UiSelect
      value={String(value)}
      disabled={disabled}
      onValueChange={(v) => {
        const opt = options.find((o) => String(o.value) === v);
        if (opt) onChange(opt.value);
      }}
    >
      <SelectTrigger aria-label={label} className={cn("h-9 w-full rounded-[10px] bg-card", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
  label?: string;
}) {
  return (
    <InputGroup className={cn("h-9 rounded-[10px] bg-card", className)}>
      <InputGroupInput
        type="number"
        aria-label={label}
        className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix && (
        <InputGroupAddon align="inline-end">
          <InputGroupText>{suffix}</InputGroupText>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      spacing={0}
      value={value}
      // Radix emits "" when the active item is clicked again; a segmented control always has a value.
      onValueChange={(v) => v && onChange(v as T)}
      className={cn("w-full rounded-[10px] bg-secondary p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          title={o.title}
          disabled={o.disabled}
          className="h-auto flex-1 rounded-[8px]! px-2.5 py-1.5 text-xs font-medium text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-card"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function SwitchField({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
}) {
  return (
    <Label className="w-full justify-between gap-3 text-[13px] font-normal text-foreground/90">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </Label>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        {hint && <span className="text-[11px] text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Pill-style panel title (single static tab) with optional right-aligned actions. */
export function PanelHeader({ icon, title, actions }: { icon?: ReactNode; title: string; actions?: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between px-2.5">
      <h2 className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-secondary px-3 text-[13px] font-medium text-foreground">
        {icon}
        {title}
      </h2>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function AppDialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 720,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        style={{ maxWidth: width }}
        className="flex max-h-[calc(100%-3rem)] w-full flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
        // Text fields handle their own Escape (e.g. cancelling an inline rename).
        onEscapeKeyDown={(e) => {
          if ((e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
        }}
      >
        <DialogHeader className="h-14 shrink-0 justify-center border-b px-5">
          <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <DialogFooter className="m-0 shrink-0 flex-row items-center justify-end gap-2 rounded-none border-t bg-transparent px-5 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
