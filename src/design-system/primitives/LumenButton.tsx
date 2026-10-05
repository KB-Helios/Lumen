import {Button, type ButtonProps} from 'react-aria-components';

import {cva} from 'class-variance-authority';

import {cn} from '../../lib/cn';

const buttonStyles = cva(
  'inline-flex min-w-[32px] cursor-default select-none items-center justify-center gap-[8px] rounded-control border font-sans outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--lumen-duration-hover)] ease-standard data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/70 data-[pressed]:translate-y-px data-[pressed]:scale-[.985] data-[pressed]:duration-[var(--lumen-duration-press)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-55',
  {
    variants: {
      variant: {
        primary: 'border-border-specular bg-accent text-text-inverse data-[hovered]:brightness-110',
        subtle: 'border-border-subtle bg-surface-raised text-text-button data-[hovered]:border-border-strong',
        quiet: 'border-transparent bg-transparent text-text-secondary shadow-none data-[hovered]:bg-surface-inset data-[hovered]:text-text-primary',
        danger: 'border-danger/45 bg-danger/10 text-danger',
      },
      size: {
        small: 'min-h-[32px] px-[10px] text-xs',
        medium: 'min-h-[36px] px-[14px] text-sm',
        large: 'min-h-[44px] px-[18px] text-[15px]',
      },
    },
    defaultVariants: {size: 'medium', variant: 'subtle'},
  },
);

export type LumenButtonVariant = 'primary' | 'subtle' | 'quiet' | 'danger';
export type LumenButtonSize = 'small' | 'medium' | 'large';

export interface LumenButtonProps extends ButtonProps {
  size?: LumenButtonSize;
  variant?: LumenButtonVariant;
}

export function LumenButton({
  className,
  size = 'medium',
  variant = 'subtle',
  ...props
}: LumenButtonProps) {
  return (
    <Button
      {...props}
      className={(renderProps) => {
        const customClassName =
          typeof className === 'function' ? className(renderProps) : className;
        return cn(buttonStyles({size, variant}), customClassName);
      }}
      data-size={size}
      data-variant={variant}
    />
  );
}

