"use client";

import { useState } from "react";
import { NavIcon } from "../dashboard-ui";
import type { NavIconId } from "../../lib/navigation";
import { onboardingCopy } from "../../lib/onboarding/onboarding-copy";
import type { OnboardingContext, ProfileData } from "../../lib/onboarding/onboarding-client";
import type { OnboardingModule, PrivacyChoice } from "../../lib/onboarding/onboarding-types";

const c = onboardingCopy;

function initialsOf(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

/* ---------------------------------- Bienvenue ---------------------------------- */
export function WelcomeStep({ firstName, onStart, onDefer, deferLabel }: {
  firstName: string; onStart: () => void; onDefer?: () => void; deferLabel?: string;
}) {
  return (
    <>
      <span className="ob-eyebrow">{c.welcome.eyebrow}</span>
      <h2 className="ob-title" data-ob-title tabIndex={-1}>{c.welcome.title(firstName)}</h2>
      <p className="ob-desc">{c.welcome.description}</p>

      <div className="ob-illustration" aria-hidden="true">
        <span className="ob-illu-gift"><NavIcon id="gift" /></span>
        <span className="ob-illu-btc"><NavIcon id="bitcoin" /></span>
        <span className="ob-illu-leaf"><NavIcon id="sprout" /></span>
        <span className="ob-illu-curve" />
      </div>

      <ul className="ob-highlights">
        {c.welcome.highlights.map((item) => (
          <li className="ob-highlight" key={item.label}>
            <span className="ob-highlight-icon" aria-hidden="true"><NavIcon id={item.icon as NavIconId} /></span>
            <span><strong>{item.label}</strong><p>{item.text}</p></span>
          </li>
        ))}
      </ul>

      <div className="ob-footer">
        <button type="button" className="ob-primary" onClick={onStart}>{c.welcome.cta}</button>
        {onDefer && <button type="button" className="ob-link" onClick={onDefer}>{deferLabel ?? c.welcome.defer}</button>}
      </div>
    </>
  );
}

/* ------------------------------ Vérifier mon profil ------------------------------ */
export function ProfileStep({ profile, readOnly, saving, error, onSubmit }: {
  profile: ProfileData; readOnly: boolean; saving: boolean; error: string | null;
  onSubmit: (patch: Partial<ProfileData>) => void;
}) {
  const [firstName, setFirstName] = useState(profile.firstName);
  const [day, setDay] = useState(profile.birthdayDay?.toString() ?? "");
  const [month, setMonth] = useState(profile.birthdayMonth?.toString() ?? "");
  const [year, setYear] = useState(profile.birthdayYear?.toString() ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  function submit() {
    if (readOnly) { onSubmit({}); return; }
    if (!firstName.trim()) { setLocalError(c.profile.nameRequired); return; }
    setLocalError(null);
    const dayNum = Number(day), monthNum = Number(month);
    const patch: Partial<ProfileData> = { firstName: firstName.trim(), language: "fr", displayCurrency: "EUR" };
    if (day && month && Number.isFinite(dayNum) && Number.isFinite(monthNum)) {
      patch.birthdayDay = dayNum;
      patch.birthdayMonth = monthNum;
      patch.birthdayYear = year ? Number(year) : null;
    }
    onSubmit(patch);
  }

  return (
    <>
      <span className="ob-eyebrow">{c.profile.eyebrow}</span>
      <h2 className="ob-title" data-ob-title tabIndex={-1}>{c.profile.title}</h2>
      <p className="ob-desc">{c.profile.description}</p>

      <div className="ob-field-avatar">
        <span className="ob-avatar" aria-hidden="true">{initialsOf(firstName || profile.firstName)}</span>
      </div>

      <div className="ob-fields">
        <label className="ob-field">
          <span>{c.profile.fields.firstName}</span>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} readOnly={readOnly} aria-readonly={readOnly} autoComplete="given-name" />
        </label>
        <div className="ob-field">
          <span>{c.profile.fields.birthday}</span>
          <div className="ob-field-row" style={{ gridTemplateColumns: "1fr 1fr 1.2fr" }}>
            <input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="JJ" aria-label="Jour" readOnly={readOnly} />
            <input inputMode="numeric" value={month} onChange={(e) => setMonth(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="MM" aria-label="Mois" readOnly={readOnly} />
            <input inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="AAAA" aria-label="Année (facultatif)" readOnly={readOnly} />
          </div>
        </div>
        <div className="ob-field-row">
          <label className="ob-field">
            <span>{c.profile.fields.language}</span>
            <select value="fr" disabled aria-disabled="true"><option value="fr">Français</option></select>
          </label>
          <label className="ob-field">
            <span>{c.profile.fields.currency}</span>
            <select value="EUR" disabled aria-disabled="true"><option value="EUR">Euro (€)</option></select>
          </label>
        </div>
      </div>

      <p className="ob-hint">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        {c.profile.birthdayHint}
      </p>

      {(error || localError) && <p className="ob-error" role="alert">{localError ?? error}</p>}

      <div className="ob-footer">
        <button type="button" className="ob-primary" onClick={submit} disabled={saving}>
          {saving ? <><span className="ob-spinner" aria-hidden="true" />{c.profile.saving}</> : c.profile.cta}
        </button>
      </div>
    </>
  );
}

/* ------------------------------ Choisir mon expérience ------------------------------ */
const MODULE_ORDER: OnboardingModule[] = ["gifts", "bitcoin", "pea", "cto"];

export function ModulesStep({ selected, giftsConfigured, onToggle, onContinue }: {
  selected: OnboardingModule[]; giftsConfigured: boolean;
  onToggle: (module: OnboardingModule) => void; onContinue: () => void;
}) {
  return (
    <>
      <span className="ob-eyebrow">{c.modules.eyebrow}</span>
      <h2 className="ob-title" data-ob-title tabIndex={-1}>{c.modules.title}</h2>
      <p className="ob-desc">{c.modules.description}</p>

      <div className="ob-options" role="group" aria-label={c.modules.title}>
        {MODULE_ORDER.map((key) => {
          const option = c.modules.options[key];
          const isSelected = selected.includes(key);
          const showBadge = key === "gifts" && giftsConfigured;
          return (
            <button
              key={key}
              type="button"
              role="button"
              aria-pressed={isSelected}
              className={isSelected ? "ob-option selected" : "ob-option"}
              onClick={() => onToggle(key)}
            >
              <span className="ob-option-icon" aria-hidden="true"><NavIcon id={option.icon as NavIconId} /></span>
              <span className="ob-option-body">
                <strong>{option.title}</strong>
                <p>{option.description}</p>
              </span>
              {showBadge && <span className="ob-option-badge">{c.modules.alreadyConfigured}</span>}
              <span className="ob-option-check" aria-hidden="true">{isSelected ? "✓" : ""}</span>
            </button>
          );
        })}
      </div>

      <p className="ob-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3Z" /></svg>
        {c.modules.footNote}
      </p>

      <div className="ob-footer">
        <button type="button" className="ob-primary" onClick={onContinue}>{c.modules.cta}</button>
      </div>
    </>
  );
}

/* -------------------------------- Confidentialité -------------------------------- */
const PRIVACY_ORDER: PrivacyChoice[] = ["private", "admin", "custom"];

export function PrivacyStep({ adminName, choice, onChoice, adminCanEdit, onToggleEdit, saving, error, onConfirm }: {
  adminName: string; choice: PrivacyChoice; onChoice: (choice: PrivacyChoice) => void;
  adminCanEdit: boolean; onToggleEdit: (next: boolean) => void;
  saving: boolean; error: string | null; onConfirm: () => void;
}) {
  const [learnOpen, setLearnOpen] = useState(false);

  function labelFor(key: PrivacyChoice) {
    if (key === "admin") return { title: c.privacy.options.admin.title(adminName), description: c.privacy.options.admin.description(adminName) };
    return { title: c.privacy.options[key].title as string, description: c.privacy.options[key].description as string };
  }

  return (
    <>
      <span className="ob-eyebrow">{c.privacy.eyebrow}</span>
      <h2 className="ob-title" data-ob-title tabIndex={-1}>{c.privacy.title}</h2>
      <p className="ob-desc">{c.privacy.description}</p>

      <div className="ob-radios" role="radiogroup" aria-label={c.privacy.title}>
        {PRIVACY_ORDER.map((key) => {
          const { title, description } = labelFor(key);
          const isSelected = choice === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={isSelected ? "ob-radio selected" : "ob-radio"}
              onClick={() => onChoice(key)}
            >
              <span className="ob-radio-dot" aria-hidden="true" />
              <span className="ob-radio-body"><strong>{title}</strong><p>{description}</p></span>
            </button>
          );
        })}
      </div>

      <div className="ob-toggle-row">
        <span className="ob-toggle-copy">
          <strong>{c.privacy.adminEditToggle}</strong>
          <p>{c.privacy.adminEditHint}</p>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={adminCanEdit}
          aria-label={c.privacy.adminEditToggle}
          className={adminCanEdit ? "ob-switch on" : "ob-switch"}
          onClick={() => onToggleEdit(!adminCanEdit)}
        >
          <span className="ob-switch-thumb" aria-hidden="true" />
        </button>
      </div>

      {choice === "custom" && <p className="ob-hint">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        {c.privacy.customNote}
      </p>}

      <div className="ob-info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3Z" /></svg>
        <span>{c.privacy.info}</span>
      </div>

      <button type="button" className="ob-learn" aria-expanded={learnOpen} onClick={() => setLearnOpen((v) => !v)}>{c.privacy.learnMore}</button>
      {learnOpen && <p className="ob-learn-body">{c.privacy.learnMoreBody}</p>}

      {error && <p className="ob-error" role="alert">{error}</p>}

      <div className="ob-footer">
        <button type="button" className="ob-primary" onClick={onConfirm} disabled={saving}>
          {saving ? <><span className="ob-spinner" aria-hidden="true" />{c.privacy.saving}</> : c.privacy.cta}
        </button>
      </div>
    </>
  );
}

/* --------------------------------- Confirmation --------------------------------- */
export function CompletionStep({ firstName, context, saving, onDone, secondary, onDeferLink }: {
  firstName: string; context: OnboardingContext | null; saving: boolean;
  onDone: () => void; secondary?: { label: string; onClick: () => void }; onDeferLink?: () => void;
}) {
  const giftsText = !context || context.giftCount === 0
    ? c.completion.cards.giftsNone
    : c.completion.cards.gifts(context.giftCount, context.earliestGiftYear);
  const bitcoinText = !context || context.btcAttributed <= 0
    ? c.completion.cards.bitcoinNone
    : c.completion.cards.bitcoin(context.btcAttributed.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""));
  const investText = context?.hasPea
    ? c.completion.cards.investmentsPea
    : context?.hasCto ? c.completion.cards.investmentsCto : c.completion.cards.investmentsNone;

  const cards: { icon: NavIconId; label: string; text: string }[] = [
    { icon: "gift", label: c.completion.cards.giftsLabel, text: giftsText },
    { icon: "bitcoin", label: c.completion.cards.bitcoinLabel, text: bitcoinText },
    { icon: "trending-up", label: c.completion.cards.investmentsLabel, text: investText },
  ];

  return (
    <>
      <div className="ob-done-mark" aria-hidden="true">✓</div>
      <span className="ob-eyebrow" style={{ textAlign: "center", display: "block" }}>{c.completion.eyebrow}</span>
      <h2 className="ob-title" data-ob-title tabIndex={-1} style={{ textAlign: "center" }}>{c.completion.title}</h2>
      <p className="ob-desc" style={{ textAlign: "center", margin: "0 auto" }}>{c.completion.subtitle(firstName)}</p>

      <div className="ob-summary">
        {cards.map((card) => (
          <div className="ob-summary-card" key={card.label}>
            <span className="ob-summary-icon" aria-hidden="true"><NavIcon id={card.icon} /></span>
            <span><strong>{card.label}</strong><p>{card.text}</p></span>
          </div>
        ))}
      </div>

      <div className="ob-footer">
        <button type="button" className="ob-primary" onClick={onDone} disabled={saving}>
          {saving ? <><span className="ob-spinner" aria-hidden="true" />{c.completion.cta}</> : c.completion.cta}
        </button>
        {secondary && <button type="button" className="ob-secondary" onClick={secondary.onClick}>{secondary.label}</button>}
        {onDeferLink && <button type="button" className="ob-link" onClick={onDeferLink}>{c.completion.deferLink}</button>}
      </div>
    </>
  );
}
