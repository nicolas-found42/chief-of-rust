import { NavLink } from "react-router-dom";

/**
 * Meeting Wizard's two internal tabs (issue #194). Route-backed rather than
 * component state: Today lives at `/meetings` and This week at
 * `/meetings/weekly`, so each is directly navigable, survives a refresh, and
 * answers to Back and Forward like any other page.
 *
 * `aria-current="page"` marks the tab in use, which is what a screen reader
 * announces and what forced-colors mode still shows once the fill is
 * discarded — the state is never carried by colour alone (WCAG 1.4.1).
 */
const TABS = [
  { to: "/meetings", label: "Today" },
  { to: "/meetings/weekly", label: "This week" },
];

export function MeetingWizardTabs() {
  return (
    <nav className="wizard-tabs" aria-label="Meeting Wizard views">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end className="wizard-tab">
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
