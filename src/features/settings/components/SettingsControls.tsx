import type {ReactNode} from 'react';

import {
  Button,
  Checkbox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Switch,
  TextField,
  type CheckboxProps,
  type Key,
  type SwitchProps,
} from 'react-aria-components';

import {LumenUiIcon} from '../../../design-system/icons/LumenUiIcon';

const visuallyHidden = 'absolute size-px overflow-hidden [clip-path:inset(50%)]';
const focusRing = 'data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/70';

export function LumenSwitch(props: SwitchProps) {
  return (
    <Switch
      {...props}
      className={({isDisabled, isFocusVisible}) => [
        'flex min-h-[32px] w-[42px] shrink-0 items-center rounded-pill outline-none',
        isFocusVisible ? 'ring-2 ring-focus/70' : '',
        isDisabled ? 'opacity-45' : '',
      ].filter(Boolean).join(' ')}
    >
      {({isSelected}) => (
        <span aria-hidden="true" className={['flex h-[24px] w-[42px] items-center rounded-pill border p-[2px] transition-[background-color,border-color] duration-[var(--lumen-duration-selection)] ease-standard', isSelected ? 'border-accent bg-accent' : 'border-border-strong bg-surface-raised'].join(' ')}>
          <span className={['size-[18px] rounded-pill shadow-control transition-transform duration-[var(--lumen-duration-selection)] ease-standard', isSelected ? 'translate-x-[18px] bg-text-inverse' : 'bg-text-primary'].join(' ')} />
        </span>
      )}
    </Switch>
  );
}

export interface SelectOption<T extends string> { id: T; label: string; }

export interface LumenSelectProps<T extends string> {
  'aria-label': string;
  options: readonly SelectOption<T>[];
  value: T;
  onChange(value: T): void;
  isDisabled?: boolean;
}

export function LumenSelect<T extends string>({options, value, onChange, isDisabled, ...props}: LumenSelectProps<T>) {
  const handleChange = (key: Key | null) => {
    if (key !== null) onChange(String(key) as T);
  };
  return (
    <Select aria-label={props['aria-label']} className="min-w-0 w-full max-w-[300px]" isDisabled={isDisabled} selectedKey={value} onSelectionChange={handleChange}>
      <Label className={visuallyHidden}>{props['aria-label']}</Label>
      <Button className={`flex min-h-[36px] min-w-0 w-full items-center justify-between gap-[8px] rounded-control border border-border-subtle bg-surface-raised px-[12px] py-[6px] text-left font-sans text-sm text-text-primary outline-none transition-[background-color,border-color] duration-[var(--lumen-duration-hover)] ease-standard data-[hovered]:border-border-strong data-[disabled]:cursor-not-allowed data-[disabled]:opacity-55 ${focusRing}`}>
        <SelectValue className="min-w-0 [overflow-wrap:anywhere]" />
        <LumenUiIcon className="shrink-0 rotate-90" name="next" size="small" />
      </Button>
      <Popover className="lumen-control-popover w-[var(--trigger-width)] max-h-[var(--available-height)] max-w-[calc(100vw-32px)] overflow-y-auto rounded-control border border-border-strong bg-surface-raised p-[6px] text-text-primary shadow-surface">
        <ListBox className="min-w-0 outline-none" items={options}>
          {(option) => (
            <ListBoxItem
              id={option.id}
              textValue={option.label}
              className={({isFocused, isSelected}) => [
                'flex min-h-[36px] min-w-0 items-center justify-between gap-[12px] rounded-control px-[10px] py-[8px] font-sans text-sm outline-none',
                isFocused ? 'bg-surface-inset' : '',
                isSelected ? 'text-accent' : '',
              ].filter(Boolean).join(' ')}
            >
              {({isSelected}) => <><span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>{isSelected ? <LumenUiIcon className="shrink-0" name="approval" size="small" /> : null}</>}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

export interface LumenSliderProps {
  label: string; maxValue?: number; minValue?: number; step?: number; suffix?: string; value: number; onChange(value: number): void;
}

export function LumenSlider({label, maxValue = 100, minValue = 0, step = 1, suffix = '%', value, onChange}: LumenSliderProps) {
  return (
    <Slider aria-label={label} className="grid min-w-0 w-[168px] max-w-full grid-cols-[minmax(0,1fr)_auto] gap-[8px]" maxValue={maxValue} minValue={minValue} step={step} value={value} onChange={(next) => onChange(Array.isArray(next) ? (next[0] ?? value) : next)}>
      <Label className={visuallyHidden}>{label}</Label>
      <SliderOutput className="font-sans text-xs text-text-secondary">{({state}) => `${state.getThumbValue(0)}${suffix}`}</SliderOutput>
      <SliderTrack className="col-span-full flex h-[32px] items-center"><span aria-hidden="true" className="h-[4px] w-full rounded-pill bg-surface-inset" /><SliderThumb className={`size-[16px] rounded-pill border border-border-specular bg-accent shadow-control outline-none ${focusRing}`} /></SliderTrack>
    </Slider>
  );
}

export function LumenCheckbox({children, ...props}: CheckboxProps & {children: ReactNode}) {
  return (
    <Checkbox {...props} className="inline-flex min-h-[36px] min-w-0 items-center gap-[8px] font-sans text-sm text-text-secondary outline-none">
      {({isFocusVisible, isSelected}) => (
        <><span className={["grid size-[18px] shrink-0 place-items-center rounded border border-border-strong bg-surface-raised text-text-inverse", isSelected ? 'border-accent bg-accent' : '', isFocusVisible ? 'ring-2 ring-focus/70' : ''].filter(Boolean).join(' ')}>{isSelected ? <LumenUiIcon name="approval" size="small" /> : null}</span><span className="min-w-0 [overflow-wrap:anywhere]">{children}</span></>
      )}
    </Checkbox>
  );
}

export interface LumenTextFieldProps {
  'aria-label': string; placeholder?: string; value: string; onChange(value: string): void; onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>; type?: 'text' | 'password';
}

export function LumenTextField(props: LumenTextFieldProps) {
  return <TextField aria-label={props['aria-label']} className="grid min-w-0 w-full gap-[4px]" value={props.value} onChange={props.onChange}><Input className={`min-h-[36px] min-w-0 w-full rounded-control border border-border-subtle bg-surface-inset px-[12px] py-[6px] font-sans text-sm text-text-primary caret-accent outline-none ${focusRing}`} placeholder={props.placeholder} type={props.type} onKeyDown={props.onKeyDown} /></TextField>;
}
