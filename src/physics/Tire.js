// Combined-slip tire model: a normalised Pacejka "magic formula" evaluated on a friction
// ellipse. Slip ratio and slip angle are normalised by their peak values so both directions
// share one curve; this keeps the force bounded by mu*Fz in every direction (stable) while
// preserving the peak-then-falloff shape that makes drifting progressive.

export class TireModel {
  /**
   * @param {object} p
   * @param {number} p.mu        peak friction coefficient
   * @param {number} p.peakSlipRatio   slip ratio at peak longitudinal force (~0.08-0.12)
   * @param {number} p.peakSlipAngle   slip angle (rad) at peak lateral force (~0.12-0.16)
   * @param {number} p.shape     Pacejka C; higher = more force drop after the peak
   * @param {number} p.loadSensitivity  mu drop per unit of (Fz/Fz0 - 1)
   * @param {number} p.nominalLoad      Fz0 in N
   */
  constructor(p) {
    this.set(p);
  }

  set(p) {
    this.mu = p.mu;
    this.peakSlipRatio = p.peakSlipRatio;
    this.peakSlipAngle = p.peakSlipAngle;
    this.tanPeakAngle = Math.tan(p.peakSlipAngle);
    this.C = p.shape;
    // B chosen so the curve peaks exactly at normalised slip 1.
    this.B = Math.tan(Math.PI / (2 * this.C));
    this.loadSensitivity = p.loadSensitivity;
    this.nominalLoad = p.nominalLoad;
    this.lateralScale = p.lateralScale ?? 1.0;
  }

  /** Normalised force (0..1) for combined normalised slip rho >= 0. */
  curve(rho) {
    return Math.sin(this.C * Math.atan(this.B * rho));
  }

  /** Initial slope of curve() at rho = 0. */
  get slope0() {
    return this.C * this.B;
  }

  /** Peak force for a given load (N) and surface grip multiplier. */
  peakForce(Fz, surfaceGrip) {
    const k = 1 - this.loadSensitivity * (Fz / this.nominalLoad - 1);
    return Fz * this.mu * surfaceGrip * Math.min(1.25, Math.max(0.6, k));
  }

  /**
   * Evaluate combined forces.
   * @param {number} slipRatio   kappa
   * @param {number} tanSlipAngle  tan(alpha), positive when the contact patch slides to +lateral
   * @param {number} Fpeak       from peakForce()
   * @param {object} out         receives fx, fy, rho, usage
   */
  evaluate(slipRatio, tanSlipAngle, Fpeak, out) {
    const sx = slipRatio / this.peakSlipRatio;
    const sy = tanSlipAngle / this.tanPeakAngle;
    const rho = Math.hypot(sx, sy);
    out.rho = rho;
    if (rho < 1e-6 || Fpeak <= 0) {
      out.fx = 0;
      out.fy = 0;
      out.usage = 0;
      return out;
    }
    const f = this.curve(rho) * Fpeak;
    out.fx = (f * sx) / rho;
    out.fy = (-f * sy * this.lateralScale) / rho;
    out.usage = f / Fpeak;
    return out;
  }
}
