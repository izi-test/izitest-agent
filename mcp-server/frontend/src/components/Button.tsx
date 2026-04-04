import type { ButtonHTMLAttributes, ElementType } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'action' | 'save' | 'danger' | 'cancel' | 'back';
  size?: 'md' | 'sm';
  icon?: ElementType;
  iconPosition?: 'left' | 'right';
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  children,
  className = '',
  ...props
}: ButtonProps) {
  let baseClass = '';
  switch (variant) {
    case 'primary': baseClass = 'btn-primary'; break;
    case 'action': baseClass = 'btn-action'; break;
    case 'save': baseClass = 'btn-action btn-save'; break;
    case 'danger': baseClass = 'btn-action btn-danger'; break;
    case 'cancel': baseClass = 'btn-action btn-cancel'; break;
    case 'back': baseClass = 'btn-back'; break;
  }

  if (size === 'sm') {
    baseClass += ' btn-sm';
  }

  return (
    <button className={`${baseClass} ${className}`.trim()} {...props}>
      {Icon && iconPosition === 'left' && <Icon size={size === 'sm' ? 14 : 16} />}
      {children}
      {Icon && iconPosition === 'right' && <Icon size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}
