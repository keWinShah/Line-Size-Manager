/* PSV sizing engine (API 520 Part I, SI form). Runs in the browser.
   Internal units: pressure kPa, mass flow kg/h, liquid flow L/min, temperature K, area mm2. */
(function (root) {
  const ATM = 101.325;
  const ORIFICES = [["D",71],["E",126.5],["F",198.1],["G",324.5],["H",506.5],["J",830.3],["K",1185.8],["L",1840.6],["M",2322.6],["N",2800],["P",4116.1],["Q",7129],["R",10322.6],["T",16774.2]];
  const UNIT_SETS = {
    bar:  {p:"bar(g)",w:"kg/h",q:"m³/h",t:"C"},
    kpa:  {p:"kPa(g)",w:"kg/h",q:"L/min",t:"C"},
    kgcm: {p:"kg/cm²(g)",w:"kg/h",q:"m³/h",t:"C"},
    us:   {p:"psig",w:"lb/h",q:"gpm",t:"F"}
  };
  const P_TO_KPA = {"bar(g)":100,"kPa(g)":1,"kg/cm²(g)":98.0665,"psig":6.894757};
  const W_TO_KGH = {"kg/h":1,"lb/h":0.45359237};
  const Q_TO_LMIN = {"m³/h":1000/60,"L/min":1,"gpm":3.785412};

  const pG = (v,u) => v * P_TO_KPA[UNIT_SETS[u].p];
  const wK = (v,u) => v * W_TO_KGH[UNIT_SETS[u].w];
  const qL = (v,u) => v * Q_TO_LMIN[UNIT_SETS[u].q];
  const tK = (v,u) => UNIT_SETS[u].t === "F" ? (v - 32) * 5/9 + 273.15 : v + 273.15;
  const relieving = (set, op) => set * (1 + op/100);

  function selectOrifice(a) {
    for (const [letter, area] of ORIFICES)
      if (area >= a) return {letter, area_mm2: area, utilization_pct: 100*a/area};
    return {letter: null, area_mm2: null, utilization_pct: null};
  }

  function cCoeff(k) { return 520 * Math.sqrt(k * Math.pow(2/(k+1), (k+1)/(k-1))); }
  function f2Coeff(k, r) {
    return Math.sqrt(k/(k-1) * Math.pow(r, 2/k) * (1 - Math.pow(r, (k-1)/k)) / (1 - r));
  }

  function sizeGas(W, setG, op, backG, T, Z, M, k, Kd, Kb, Kc) {
    const P1 = relieving(setG, op) + ATM, P2 = backG + ATM, notes = [];
    const r = P2/P1, rCrit = Math.pow(2/(k+1), k/(k-1));
    let A, regime, extra;
    if (r <= rCrit) {
      regime = "critical";
      const C = cCoeff(k);
      A = 13160 * W / (C*Kd*P1*Kb*Kc) * Math.sqrt(T*Z/M);
      extra = {C};
    } else {
      regime = "subcritical";
      const F2 = f2Coeff(k, r);
      A = 17.9 * W / (F2*Kd*Kc) * Math.sqrt(Z*T / (M*P1*(P1-P2)));
      extra = {F2};
      notes.push("Subcritical flow: Kb is not applied, F2 method used.");
    }
    if (backG > 0.1*setG && Kb === 1)
      notes.push("Backpressure above 10% of set pressure: confirm Kb for a balanced-bellows valve.");
    return Object.assign({area_mm2: A, regime, P1_kpa_abs: P1, pressure_ratio: r, critical_ratio: rCrit, notes}, extra);
  }

  function sizeLiquid(Q, setG, op, backG, G, mu, Kd, Kw, Kc) {
    const P1 = relieving(setG, op), dP = P1 - backG, notes = [];
    if (dP <= 0) throw new Error("Relieving pressure must exceed backpressure.");
    const base = 11.78 * Q / (Kd*Kw*Kc) * Math.sqrt(G/dP);
    let A = base, Kv = 1, Re = null;
    for (let i = 0; i < 50; i++) {
      Re = Q * 18800 * G / (mu * Math.sqrt(A));
      const kv = Math.min(1 / (0.9935 + 2.878/Math.sqrt(Re) + 342.75/Math.pow(Re, 1.5)), 1);
      const An = base / kv, done = Math.abs(An - A) < 1e-6 * A;
      A = An; Kv = kv;
      if (done) break;
    }
    if (Kv < 0.999) notes.push("Viscosity correction Kv applied (Re = " + Math.round(Re) + ").");
    return {area_mm2: A, P1_kpa_g: P1, dP_kpa: dP, Kv, Re, notes};
  }

  function knSteam(P1) { return P1 <= 10339 ? 1 : (0.02764*P1 - 1000) / (0.03324*P1 - 1061); }
  function sizeSteam(W, setG, op, Kd, Kb, Kc, Ksh) {
    const P1 = relieving(setG, op) + ATM, Kn = knSteam(P1), notes = [];
    const A = 190.5 * W / (P1*Kd*Kb*Kc*Kn*Ksh);
    if (Ksh === 1) notes.push("Ksh = 1.0 assumes saturated steam. Enter the superheat correction factor if superheated.");
    if (P1 > 22060) notes.push("Pressure above 22 MPa: the steam formula is outside its range.");
    return {area_mm2: A, P1_kpa_abs: P1, Kn, notes};
  }

  const REQUIRED = {
    gas: ["set_pressure","flow","temperature","mol_weight","k"],
    liquid: ["set_pressure","flow","sg","viscosity_cp"],
    steam: ["set_pressure","flow"]
  };
  const LABELS = {set_pressure:"set pressure",flow:"required flow",temperature:"temperature",mol_weight:"molecular weight",k:"Cp/Cv (k)",sg:"specific gravity",viscosity_cp:"viscosity"};

  function size(d) {
    const u = d.unit_set || "bar", fluid = d.fluid;
    if (!REQUIRED[fluid]) throw new Error("Fluid must be gas, liquid or steam.");
    for (const f of REQUIRED[fluid])
      if (!Number.isFinite(d[f])) throw new Error("Enter a value for " + LABELS[f] + ".");
    const num = (v, dflt) => Number.isFinite(v) && v > 0 ? v : dflt;
    const setG = pG(d.set_pressure, u);
    const op = Number.isFinite(d.overpressure) ? d.overpressure : 10;
    const back = pG(Number.isFinite(d.backpressure) ? d.backpressure : 0, u);
    const Kb = num(d.Kb, 1), Kc = num(d.Kc, 1);
    if (setG <= 0) throw new Error("Set pressure must be greater than zero.");
    if (op < 0 || op > 50) throw new Error("Overpressure should be between 0 and 50 %.");
    if (d.flow <= 0) throw new Error("Required flow must be greater than zero.");
    let res;
    if (fluid === "gas") {
      if (d.mol_weight <= 0 || d.k <= 1) throw new Error("Molecular weight must be positive and k must be greater than 1.");
      res = sizeGas(wK(d.flow,u), setG, op, back, tK(d.temperature,u), num(d.Z,1), d.mol_weight, d.k, num(d.Kd,0.975), Kb, Kc);
    } else if (fluid === "liquid") {
      if (d.sg <= 0 || d.viscosity_cp <= 0) throw new Error("Specific gravity and viscosity must be positive.");
      res = sizeLiquid(qL(d.flow,u), setG, op, back, d.sg, d.viscosity_cp, num(d.Kd,0.65), num(d.Kw,1), Kc);
    } else {
      res = sizeSteam(wK(d.flow,u), setG, op, num(d.Kd,0.975), Kb, Kc, num(d.Ksh,1));
    }
    res.orifice = selectOrifice(res.area_mm2);
    if (!res.orifice.letter) res.notes.push("Required area exceeds a T orifice: use multiple valves.");
    res.area_in2 = res.area_mm2 / 645.16;
    return res;
  }

  root.PSV = {size, ORIFICES, UNIT_SETS};
  if (typeof module !== "undefined") module.exports = root.PSV;
})(typeof window !== "undefined" ? window : globalThis);
