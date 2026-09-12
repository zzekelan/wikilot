import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  Braces,
  Calendar,
  ChevronRight,
  Hash,
  List,
  Lock,
  Plus,
  ToggleLeft,
  Type,
  X,
} from "lucide-react";
import type { WorkspacePropertyRegistration } from "../../shared/workspace";
import {
  addFrontmatterProperty,
  deleteFrontmatterProperty,
  parseFrontmatterProperties,
  updateFrontmatterProperty,
  type FrontmatterProperty,
  type FrontmatterPropertyType,
  type FrontmatterPropertyValue,
} from "./frontmatter-properties";

type PropertiesPanelProps = {
  source: string;
  registry: WorkspacePropertyRegistration[];
  onChange(source: string): void;
};

const PROPERTY_TYPES: Array<{
  value: FrontmatterPropertyType;
  label: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { value: "text", label: "Text", icon: Type },
  { value: "list", label: "List", icon: List },
  { value: "number", label: "Number", icon: Hash },
  { value: "date", label: "Date", icon: Calendar },
  { value: "checkbox", label: "Checkbox", icon: ToggleLeft },
];

function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [active, onOutside, ref]);
}

function commitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter") event.currentTarget.blur();
  if (event.key === "Escape") {
    event.currentTarget.value = event.currentTarget.defaultValue;
    event.currentTarget.blur();
  }
}

function numberSource(value: number): string {
  if (Number.isNaN(value)) return ".nan";
  if (value === Infinity) return ".inf";
  if (value === -Infinity) return "-.inf";
  return String(value);
}

function NumberValueInput({ label, value, onCommit }: {
  label: string;
  value: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(numberSource(value));
  useEffect(() => setDraft(numberSource(value)), [value]);

  function commit() {
    const normalized = draft.trim().toLowerCase();
    const number = normalized === ".nan" ? Number.NaN
      : normalized === ".inf" || normalized === "+.inf" ? Infinity
        : normalized === "-.inf" ? -Infinity
          : Number(draft);
    const committed = !Number.isNaN(number) || normalized === ".nan" ? number : value;
    setDraft(numberSource(committed));
    if (!Object.is(committed, value)) onCommit(committed);
  }

  return <input
    className="properties-input"
    type="text"
    inputMode="decimal"
    aria-label={label}
    value={draft}
    onChange={(event) => setDraft(event.currentTarget.value)}
    onBlur={commit}
    onKeyDown={commitOnEnter}
  />;
}

function TextValueInput({ label, value, onCommit }: {
  label: string;
  value: string | null;
  onCommit(value: string | null): void;
}) {
  const displayValue = value ?? "";
  const [draft, setDraft] = useState(displayValue);
  useEffect(() => setDraft(displayValue), [displayValue]);

  return <input
    className="properties-input"
    type="text"
    aria-label={label}
    placeholder={value === null ? "null" : "Empty"}
    value={draft}
    onChange={(event) => setDraft(event.currentTarget.value)}
    onBlur={() => {
      const next = value === null && draft.trim() === "" ? null : draft;
      if (next !== value) onCommit(next);
    }}
    onKeyDown={commitOnEnter}
  />;
}

function TypeMenu({ name, type, onPick }: {
  name: string;
  type: FrontmatterPropertyType;
  onPick(type: FrontmatterPropertyType): void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useClickOutside(menuRef, open, () => setOpen(false));
  const CurrentIcon = PROPERTY_TYPES.find((option) => option.value === type)?.icon ?? Type;

  return <span className="properties-type" ref={menuRef}>
    <button
      type="button"
      className="properties-icon-button"
      aria-label={`${name} type`}
      aria-expanded={open}
      title={`Type: ${type}`}
      onClick={() => setOpen((current) => !current)}
    ><CurrentIcon size={12} /></button>
    {open ? <span className="properties-type-menu" role="menu">
      {PROPERTY_TYPES.map((option) => <button
        type="button"
        role="menuitemradio"
        aria-checked={option.value === type}
        className={option.value === type ? "properties-type-option properties-type-option-active" : "properties-type-option"}
        key={option.value}
        onClick={() => {
          setOpen(false);
          if (option.value !== type) onPick(option.value);
        }}
      ><option.icon size={12} aria-hidden="true" />{option.label}</button>)}
    </span> : null}
  </span>;
}

function PropertyName({ property, onCommit }: {
  property: FrontmatterProperty;
  onCommit(name: string): boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  if (property.type === "nested") {
    return <span className="properties-name-label" title={property.name}>{property.name}</span>;
  }
  if (!renaming) {
    return <button
      type="button"
      className="properties-name-label"
      aria-label={`Rename property ${property.name}`}
      title={`${property.name} - click to rename`}
      onClick={() => setRenaming(true)}
    >{property.name}</button>;
  }
  return <input
    autoFocus
    className="properties-input properties-name-input"
    aria-label={`${property.name} name`}
    defaultValue={property.name}
    onBlur={(event) => {
      if (onCommit(event.currentTarget.value)) setRenaming(false);
      else event.currentTarget.value = property.name;
    }}
    onKeyDown={commitOnEnter}
  />;
}

function ListValue({ property, index, change }: {
  property: FrontmatterProperty;
  index: number;
  change(index: number, value: FrontmatterPropertyValue): void;
}) {
  const [draft, setDraft] = useState("");
  const values = Array.isArray(property.value) ? property.value : [];

  function add() {
    const value = draft.trim();
    if (!value) return;
    change(index, [...values, value]);
    setDraft("");
  }

  return <span className="properties-chips">
    {values.map((item, itemIndex) => <span className="properties-chip" key={`${String(item)}:${itemIndex}`}>
      <span className="properties-chip-label">{item === null ? "null" : String(item)}</span>
      <button
        type="button"
        className="properties-chip-remove"
        aria-label={`Remove ${property.name} value item ${itemIndex + 1}`}
        title="Remove list item"
        onClick={() => change(index, values.filter((_, valueIndex) => valueIndex !== itemIndex))}
      ><X size={11} /></button>
    </span>)}
    <input
      className="properties-chip-input"
      type="text"
      aria-label={`Add to ${property.name}`}
      placeholder="+ add"
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={add}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          add();
        }
      }}
    />
  </span>;
}

function PropertyValue({ property, index, change }: {
  property: FrontmatterProperty;
  index: number;
  change(index: number, value: FrontmatterPropertyValue): void;
}) {
  const label = `${property.name} value`;
  if (property.type === "nested") {
    return <span className="properties-nested" title="Nested properties are read-only here - edit them in source">
      <Lock size={11} aria-hidden="true" />
      <code>Nested value</code>
    </span>;
  }
  if (property.type === "checkbox") {
    const checked = property.value === true;
    return <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "properties-toggle properties-toggle-on" : "properties-toggle"}
      onClick={() => change(index, !checked)}
    ><span className="properties-toggle-thumb" aria-hidden="true" /></button>;
  }
  if (property.type === "list") return <ListValue property={property} index={index} change={change} />;
  if (property.type === "number") {
    return <NumberValueInput
      label={label}
      value={typeof property.value === "number" ? property.value : 0}
      onCommit={(value) => change(index, value)}
    />;
  }
  if (property.type === "date") {
    return <input
      className="properties-input"
      type="date"
      aria-label={label}
      value={property.value === null ? "" : String(property.value)}
      onChange={(event) => change(index, event.currentTarget.value || null)}
    />;
  }
  return <TextValueInput
    label={label}
    value={property.value === null ? null : String(property.value)}
    onCommit={(value) => change(index, value)}
  />;
}

function AddProperty({ registry, existingNames, onCreate }: {
  registry: WorkspacePropertyRegistration[];
  existingNames: ReadonlySet<string>;
  onCreate(name: string, type: FrontmatterPropertyType): boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedType, setSelectedType] = useState<FrontmatterPropertyType | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => {
    return registry
      .filter((property) => !existingNames.has(property.name))
      .slice(0, 8);
  }, [existingNames, registry]);

  function close() {
    setOpen(false);
    setName("");
    setSelectedType(null);
  }
  useClickOutside(formRef, open, close);

  function create(propertyName: string, type: FrontmatterPropertyType) {
    if (onCreate(propertyName, type)) close();
  }

  function createDraft() {
    const normalized = name.trim();
    if (!normalized || !selectedType) return;
    create(normalized, selectedType);
  }

  if (!open || !selectedType) {
    return <div className="properties-add-form" ref={formRef} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <button type="button" className="properties-add" aria-label="Add property" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
        <span className="properties-kind-icon" aria-hidden="true"><Plus size={12} /></span>
        Add property
      </button>
      {open ? <div className="properties-add-drawer">
        {suggestions.length > 0 ? <div role="listbox" aria-label="Known properties">
          {suggestions.map((property) => {
            const Icon = PROPERTY_TYPES.find((option) => option.value === property.type)?.icon ?? Type;
            return <button type="button" role="option" aria-selected={false} className="properties-suggest-option" key={property.name} onClick={() => create(property.name, property.type)}><Icon size={12} />{property.name}</button>;
          })}
        </div> : null}
        <div role="menu" aria-label="New property type">
          {PROPERTY_TYPES.map((option, index) => <button type="button" role="menuitem" autoFocus={index === 0} className="properties-type-option" key={option.value} onClick={() => setSelectedType(option.value)}><option.icon size={12} />{option.label}</button>)}
        </div>
      </div> : null}
    </div>;
  }

  return <div className="properties-add-form" ref={formRef}>
    <div className="properties-row properties-row-new">
      <span className="properties-key properties-key-add">
        <input
          autoFocus
          className="properties-input properties-name-input"
          aria-label="New property name"
          placeholder="property"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
            if (event.key !== "Enter") return;
            event.preventDefault();
            createDraft();
          }}
        />
      </span>
      <button type="button" className="properties-add" aria-label="Create property" disabled={!name.trim()} onClick={createDraft}>Add</button>
    </div>
  </div>;
}

export function PropertiesPanel({ source, registry, onChange }: PropertiesPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseFrontmatterProperties(source), [source]);
  const existingNames = useMemo(
    () => new Set(parsed.properties.map((property) => property.name)),
    [parsed.properties],
  );

  function apply(operation: () => string): boolean {
    try {
      setError(null);
      onChange(operation());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }

  function rename(index: number, currentName: string, name: string): boolean {
    const normalized = name.trim();
    if (normalized === currentName) return true;
    if (!normalized) {
      setError("Property name is required");
      return false;
    }
    return apply(() => updateFrontmatterProperty(source, index, { name: normalized }));
  }

  function changeValue(index: number, value: FrontmatterPropertyValue) {
    apply(() => updateFrontmatterProperty(source, index, { value }));
  }

  function createProperty(name: string, type: FrontmatterPropertyType): boolean {
    const created = apply(() => addFrontmatterProperty(source, name, type));
    if (created) setJustAdded(name);
    return created;
  }

  return <section className="properties-panel" aria-label="Properties">
    <button
      type="button"
      className="properties-heading"
      aria-label={expanded ? "Collapse Properties" : "Expand Properties"}
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      <ChevronRight className={expanded ? "properties-chevron properties-chevron-open" : "properties-chevron"} size={14} />
      <span>Properties</span>
      {parsed.status === "ready" && parsed.properties.length > 0
        ? <span className="properties-count">{parsed.properties.length}</span>
        : null}
    </button>
    {expanded ? parsed.status === "malformed"
      ? <p className="properties-error" role="alert">{parsed.error}</p>
      : <div className="properties-content">
        {parsed.properties.map((property, index) => {
          const valueRef = property.name === justAdded ? (element: HTMLSpanElement | null) => {
            if (!element) return;
            element.querySelector("input")?.focus();
            setJustAdded(null);
          } : undefined;
          return <div className="properties-row" key={`${index}:${property.name}`}>
            <span className="properties-key">
              {property.type === "nested"
                ? <span className="properties-kind-icon" title="Nested property - edit it in source"><Braces size={12} /></span>
                : <TypeMenu
                  name={property.name}
                  type={property.type}
                  onPick={(type) => {
                    if (!window.confirm("Changing the property type may discard part of its value. Continue?")) return;
                    apply(() => updateFrontmatterProperty(source, index, { type }));
                  }}
                />}
              <PropertyName property={property} onCommit={(name) => rename(index, property.name, name)} />
            </span>
            <span className="properties-value" ref={valueRef}>
              <PropertyValue property={property} index={index} change={changeValue} />
            </span>
            <span className="properties-actions">
              {property.type === "nested" ? null : <button
                type="button"
                className="properties-icon-button"
                aria-label={`Delete ${property.name}`}
                title="Delete property"
                onClick={() => apply(() => deleteFrontmatterProperty(source, index))}
              ><X size={12} /></button>}
            </span>
          </div>;
        })}
        <AddProperty registry={registry} existingNames={existingNames} onCreate={createProperty} />
        {error ? <p className="properties-error" role="alert">{error}</p> : null}
      </div>
      : null}
  </section>;
}
