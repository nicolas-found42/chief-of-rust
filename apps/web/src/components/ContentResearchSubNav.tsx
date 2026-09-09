import { NavLink } from "react-router-dom";

/**
 * The way into YouTube Trends, and the way back: Content Research's product
 * surface presents its Resonance watch and the Trends Module as one product,
 * so both routes carry the same sub-nav. NavLink marks the route you are on,
 * exactly as the header's tab bar does for the Modules it presents.
 */
export function ContentResearchSubNav() {
  return (
    <nav className="sub-tabs" aria-label="Content Research">
      <NavLink to="/content-research" end className="sub-tab">
        Resonance
      </NavLink>
      <NavLink to="/content-research/trends" className="sub-tab">
        YouTube Trends
      </NavLink>
    </nav>
  );
}
