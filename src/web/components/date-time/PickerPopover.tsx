import { useCallback, useContext } from 'react';
import { Popover, type PopoverProps } from 'react-aria-components';
import { UNSAFE_PortalProvider } from 'react-aria';
import { DialogElementContext } from '../dialog-context';
import { ScrollViewport } from '../ScrollViewport';

export function PickerPopover({
  children,
  className,
  ...props
}: Omit<PopoverProps, 'className'> & { className: string }) {
  const dialog = useContext(DialogElementContext);
  const getContainer = useCallback(() => dialog ?? document.body, [dialog]);
  return (
    <UNSAFE_PortalProvider getContainer={getContainer}>
      <Popover offset={8} className={`picker-popover ${className}`} {...props}>
        {(values) => (
          <ScrollViewport className="picker-viewport">
            {typeof children === 'function' ? children(values) : children}
          </ScrollViewport>
        )}
      </Popover>
    </UNSAFE_PortalProvider>
  );
}
