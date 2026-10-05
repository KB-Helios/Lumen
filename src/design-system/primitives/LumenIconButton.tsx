import type {ButtonProps} from 'react-aria-components';

import {cn} from '../../lib/cn';
import {
  LumenButton,
  type LumenButtonSize,
  type LumenButtonVariant,
} from './LumenButton';

const iconButtonSizes = {
  small: 'w-[32px]',
  medium: 'w-[36px]',
  large: 'w-[44px]',
} as const;

export interface LumenIconButtonProps extends ButtonProps {
  'aria-label': string;
  size?: LumenButtonSize;
  variant?: LumenButtonVariant;
}

export function LumenIconButton({
  className,
  size = 'medium',
  variant = 'quiet',
  ...props
}: LumenIconButtonProps) {
  return (
    <LumenButton
      {...props}
      className={(renderProps) => {
        const customClassName =
          typeof className === 'function' ? className(renderProps) : className;
        return cn('shrink-0 px-0', iconButtonSizes[size], customClassName);
      }}
      size={size}
      variant={variant}
    />
  );
}

