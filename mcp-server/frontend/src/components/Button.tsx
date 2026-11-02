import type { ButtonHTMLAttributes, ElementType } from 'react';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  // primary and save: the page's main action, solid blue; action and secondary: bordered white;
  // cancel and ghost: text only; danger: destructive, red; back: a link back.
  variant?: 'primary' | 'secondary' | 'action' | 'save' | 'danger' | 'cancel' | 'ghost' | 'back';
  size?: 'md' | 'sm';
  icon?: ElementType;
  iconPosition?: 'left' | 'right';
}

const VARIANT_CLASSES: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'btn btn--primary',
  save: 'btn btn--primary',
  secondary: 'btn btn--secondary',
  action: 'btn btn--secondary',
  cancel: 'btn btn--ghost',
  ghost: 'btn btn--ghost',
  danger: 'btn btn--danger',
  back: 'btn btn--ghost btn--back',
};

export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  children,
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  const classes = `${VARIANT_CLASSES[variant]}${size === 'sm' ? ' btn--sm' : ''} ${className}`.trim();
  // A spinner given as the icon turns.
  const spin = Icon === Loader2;
  return (
    <button type={type} className={classes} {...props}>
      {Icon && iconPosition === 'left' && <Icon size={size === 'sm' ? 14 : 16} className={spin ? 'spin' : undefined} />}
      {children}
      {Icon && iconPosition === 'right' && <Icon size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}
