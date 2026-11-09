"""Independent first-principles hand calculation for the 1973 Modular Radiator System (MRS) thermal-vacuum test.

This is NOT OpenFLUME.  It is a comparator that shares the protocol of docs/validation/mrs-protocol.md and reads its
inputs from the registry in validation/data/digitized/mrs/.  Nothing is tuned to the test data.

Model.  Each panel is eleven main tubes at 6.0 in centres with 0.02 in aluminium sheet between them.  The main flow of a leg
is split equally across the eleven tubes (option --split-exponent weights by tube length instead).  Each tube is marched
along its length in segments.  In each segment the fluid exchanges heat with a tube wall at a single temperature Tw
through a convection coefficient from a Nusselt correlation.  The wall rejects heat to the sink through the exposed tube
crown and through the adjacent fin, which is solved as a one-dimensional conduction problem with temperature-dependent
radiation and a uniform absorbed flux (shooting method).  The fin heat as a function of the wall temperature is tabulated
once per absorbed flux.  The prime tube is not modelled, as in the 1973 model (a separate circuit, see the protocol).

Inputs.  Registry and panel-outlet CSVs, the R21 transport table (viscosity and conductivity), and CoolProp 8.0.0 for the
R21 density, specific heat and enthalpy.  Run with `pip install -r scripts/reference/requirements-mrs.txt`.

Usage:  python scripts/reference/mrs_hand_calc.py [--out results.csv] [--points 1A,4,...] [--set primary|all]
"""
import argparse
import csv
import math
import os
from collections import defaultdict

import numpy as np
import CoolProp.CoolProp as CP

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "validation", "data", "digitized", "mrs"))

SIGMA = 5.670374419e-8
IN = 0.0254
FT = 0.3048
BTUHR_FT2_TO_W_M2 = 3.15459075
LBHR_TO_KGS = 0.45359237 / 3600.0
W_TO_BTUHR = 3.412141633
P_SYS = 1.5e6  # Pa.  The loop pressure is not published.  Liquid properties change by under 0.5 % between 1 and 2 MPa.
FLUID = "R21"

TUBE_L_FT = [3 + 2 * i for i in range(11)]  # tubes 1..11, Vol III Table 1
D_I = 0.125 * IN  # Vol III Table 1 and Vol VIII Fig. 2
OD = (0.125 + 2 * 0.033) * IN  # wall 0.033 in, Vol VIII Fig. 2
PITCH = 6.0 * IN  # Vol II section 3.1
T_SHEET = 0.020 * IN  # Vol II section 3.1
T_SINK_F = -280.0
EMISSIVITY = 0.90
K_FIN = 200.9  # W/m-K, NIST 6063-T5 fit at 295 K (upper end of the fit range), see the protocol
TWO_SIDED_EXTRA = 0.67  # effective cavity area of a two-sided panel as a fraction of the panel area (Vol III section 3.0)


def f2k(f):
    return (f - 32.0) / 1.8 + 273.15


def k2f(k):
    return (k - 273.15) * 1.8 + 32.0


class Props:
    """R21 properties.  rho, cp, h from CoolProp.  mu and k from the committed transport table."""

    def __init__(self, mu_scale=1.0, k_scale=1.0):
        rows = list(csv.DictReader(open(os.path.join(DATA, "mrs_r21_transport_table.csv"))))
        self.tf = np.array([float(r["T_F"]) for r in rows])
        self.lnmu = np.log(np.array([float(r["mu_Pa_s"]) for r in rows]))
        self.kk = np.array([float(r["k_W_mK"]) for r in rows])
        self.mu_scale = mu_scale
        self.k_scale = k_scale

    def rho(self, tf):
        return CP.PropsSI("D", "T", f2k(tf), "P", P_SYS, FLUID)

    def cp(self, tf):
        return CP.PropsSI("C", "T", f2k(tf), "P", P_SYS, FLUID)

    def h(self, tf):
        return CP.PropsSI("H", "T", f2k(tf), "P", P_SYS, FLUID)

    def mu(self, tf):
        return self.mu_scale * math.exp(float(np.interp(tf, self.tf, self.lnmu)))

    def k(self, tf):
        return self.k_scale * float(np.interp(tf, self.tf, self.kk))

    def t_from_h(self, h):
        lo, hi = -150.0, 250.0
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            if self.h(mid) < h:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)


def nusselt(re, pr, laminar=3.66):
    """Laminar value to Re 2300, Gnielinski (1995, Petukhov friction factor) from Re 4000, linear blend between."""

    def gn(r):
        f = (0.79 * math.log(r) - 1.64) ** -2
        return (f / 8) * (r - 1000) * pr / (1 + 12.7 * math.sqrt(f / 8) * (pr ** (2 / 3) - 1))

    if re <= 2300:
        return laminar
    if re >= 4000:
        return gn(re)
    w = (re - 2300) / (4000 - 2300)
    return (1 - w) * laminar + w * gn(4000)


class FinTable:
    """Heat flowing from the tube wall into ONE side of the fin, W per metre of tube, as a function of wall temperature."""

    def __init__(self, qabs_btu, eps, sides, k_fin):
        self.qabs = qabs_btu * BTUHR_FT2_TO_W_M2
        self.eps = eps
        self.ts = f2k(T_SINK_F)
        self.sides = sides
        self.k = k_fin
        self.b = PITCH / 2 - OD / 2
        self.tgrid = np.linspace(f2k(-120), f2k(220), 69)
        self.q = np.array([self._solve(t) for t in self.tgrid])

    def g(self, t):
        """Net loss per unit panel area, W/m2.  sides is the effective emitting area over the panel area."""
        return self.sides * self.eps * SIGMA * (t**4 - self.ts**4) - self.qabs

    def _shoot(self, tm, n=60):
        h = self.b / n
        t, f = tm, 0.0
        for _ in range(n):
            k1 = (f / (self.k * T_SHEET), self.g(t))
            k2 = (
                (f + h / 2 * k1[1]) / (self.k * T_SHEET),
                self.g(t + h / 2 * k1[0]),
            )
            k3 = (
                (f + h / 2 * k2[1]) / (self.k * T_SHEET),
                self.g(t + h / 2 * k2[0]),
            )
            k4 = ((f + h * k3[1]) / (self.k * T_SHEET), self.g(t + h * k3[0]))
            t += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
            f += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
        return t, f

    def _solve(self, tw):
        lo, hi = max(tw - 250.0, 50.0), tw + 250.0
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            t, _f = self._shoot(mid)
            if t < tw:
                lo = mid
            else:
                hi = mid
        return self._shoot(0.5 * (lo + hi))[1]

    def q_total(self, tw):
        return 2 * float(np.interp(tw, self.tgrid, self.q)) + OD * self.g(tw)


def tube_march(tin_f, mdot, length_m, fin, props, laminar, hscale, nseg):
    tf = tin_f
    q_sum = 0.0
    ds = length_m / nseg
    for _ in range(nseg):
        re = 4 * mdot / (math.pi * D_I * props.mu(tf))
        pr = props.cp(tf) * props.mu(tf) / props.k(tf)
        h = hscale * nusselt(re, pr, laminar) * props.k(tf) / D_I
        gi = h * math.pi * D_I  # W/m-K
        tfk = f2k(tf)
        lo, hi = max(tfk - 200.0, 60.0), tfk + 60.0
        for _ in range(50):
            tw = 0.5 * (lo + hi)
            if gi * (tfk - tw) - fin.q_total(tw) > 0:
                lo = tw
            else:
                hi = tw
        q = gi * (tfk - tw) * ds
        tf -= 1.8 * q / (mdot * props.cp(tf))
        q_sum += q
    return tf, q_sum


def read_registry(path=None):
    path = path or os.path.join(DATA, "mrs_test_point_registry.csv")
    reg = {}
    for r in csv.DictReader(open(path)):
        r["legs"] = [[int(x) for x in leg.split("-")] for leg in r["legs"].split(";")] if r["legs"] else []
        r["fractions"] = [float(x) for x in r["leg_fraction_used"].split(";")] if r["leg_fraction_used"] else []
        r["flux"] = {i: float(r["absorbed_panel%d_Btuhr_ft2" % i]) for i in range(1, 9) if r["absorbed_panel%d_Btuhr_ft2" % i] != ""}
        reg[r["test_point"]] = r
    return reg


def read_outlets():
    out = defaultdict(dict)
    for r in csv.DictReader(open(os.path.join(DATA, "mrs_panel_outlets_figs15_33.csv"))):
        out[r["test_point"]][int(r["panel"])] = (
            float(r["Tout_panel_test_F"]) if r["Tout_panel_test_F"] else None,
            float(r["Tout_panel_1973model_F"]) if r["Tout_panel_1973model_F"] else None,
        )
    return out


def read_system_outlets():
    """Printed mixed main outlet temperatures from the maps, (1973 model, test)."""
    out = {}
    for r in csv.DictReader(open(os.path.join(DATA, "mrs_system_outlets_figs15_33.csv"))):
        out[r["test_point"]] = (
            float(r["Tout_main_mixed_1973model_F"]) if r["Tout_main_mixed_1973model_F"] else None,
            float(r["Tout_main_mixed_test_F"]) if r["Tout_main_mixed_test_F"] else None,
        )
    return out


def run_point(rec, props, opt, fin_cache):
    sides = 1.0 + (TWO_SIDED_EXTRA if int(rec["sides_radiating"]) == 2 else 0.0)
    if opt["sides_override"] is not None:
        sides = opt["sides_override"] if int(rec["sides_radiating"]) == 2 else 1.0
    total = float(rec["total_main_flow_lbhr"]) if opt["flow_basis"] == "registry" else opt["flow_override"].get(rec["test_point"], float(rec["total_main_flow_lbhr"]))
    w = np.array([L ** opt["split_exponent"] for L in TUBE_L_FT])
    w = w / w.sum()
    res = {}
    for leg, fr in zip(rec["legs"], rec["fractions"]):
        m_leg = total * fr * LBHR_TO_KGS
        t = float(rec["Tin_main_F"])
        for p in leg:
            qabs = rec["flux"][p] * opt["flux_scale"]
            key = (round(qabs, 4), sides, opt["eps"], opt["k_fin"])
            if key not in fin_cache:
                fin_cache[key] = FinTable(qabs, opt["eps"], sides, opt["k_fin"])
            hout = 0.0
            qsum = 0.0
            for L, wi in zip(TUBE_L_FT, w):
                to, q = tube_march(t, m_leg * wi, L * FT, fin_cache[key], props, opt["laminar"], opt["hscale"], opt["nseg"])
                hout += wi * props.h(to)
                qsum += q
            tout = props.t_from_h(hout)
            res[p] = dict(Tin=t, Tout=tout, Q_btuhr=qsum * W_TO_BTUHR, m_leg_lbhr=m_leg / LBHR_TO_KGS)
            t = tout
    return res


def system_metrics(rec, props, panel_out, outlets_test, outlets_1973):
    """Bank heat and mixed main outlet from leg-end temperatures with the registry flows and the same enthalpy function."""
    total = float(rec["total_main_flow_lbhr"])
    tin = float(rec["Tin_main_F"])
    out = {}
    for name, temps in (("model", panel_out), ("test", outlets_test), ("1973", outlets_1973)):
        q = 0.0
        hmix = 0.0
        ok = True
        for leg, fr in zip(rec["legs"], rec["fractions"]):
            last = leg[-1]
            t = temps.get(last)
            if t is None:
                ok = False
                break
            m = total * fr
            q += m * (props.h(tin) - props.h(t)) / 1000.0 * 0.429923  # lb/hr * kJ/kg -> Btu/hr
            hmix += fr * props.h(t)
        out[name] = (q, props.t_from_h(hmix)) if ok else (None, None)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="write the per-panel results CSV here (and OUT_system.csv beside it)")
    ap.add_argument("--points", default=None, help="comma separated test points (default the primary set)")
    ap.add_argument("--set", default="primary", choices=["primary", "all"])
    ap.add_argument("--mu-scale", type=float, default=1.0)
    ap.add_argument("--k-scale", type=float, default=1.0)
    ap.add_argument("--flux-scale", type=float, default=1.0)
    ap.add_argument("--eps", type=float, default=EMISSIVITY)
    ap.add_argument("--k-fin", type=float, default=K_FIN)
    ap.add_argument("--split-exponent", type=float, default=0.0, help="tube flow weight is length**p (0 means equal)")
    ap.add_argument("--laminar-nu", type=float, default=3.66)
    ap.add_argument("--h-scale", type=float, default=1.0)
    ap.add_argument("--segments", type=int, default=24)
    ap.add_argument("--two-sided-factor", type=float, default=None, help="total effective area factor for two-sided points (default 1.67)")
    args = ap.parse_args()

    reg = read_registry()
    outlets = read_outlets()
    sysout = read_system_outlets()
    props = Props(args.mu_scale, args.k_scale)
    opt = dict(
        flux_scale=args.flux_scale, eps=args.eps, k_fin=args.k_fin, split_exponent=args.split_exponent, laminar=args.laminar_nu,
        hscale=args.h_scale, nseg=args.segments, sides_override=args.two_sided_factor, flow_basis="registry", flow_override={},
    )
    if args.points:
        tps = args.points.split(",")
    elif args.set == "all":
        tps = [t for t, r in reg.items() if r["set"] in ("primary", "secondary", "excluded") and r["legs"] and t in outlets]
    else:
        tps = [t for t, r in reg.items() if r["set"] == "primary"]
    fin_cache = {}
    rows = []
    sysrows = []
    errs, errs73, qerr, qerr73, tmix_err, tmix_err_printed, tmix73_printed = [], [], [], [], [], [], []
    for tp in tps:
        rec = reg[tp]
        res = run_point(rec, props, opt, fin_cache)
        for p, v in res.items():
            tt, t73 = outlets[tp].get(p, (None, None))
            rows.append([tp, rec["set"], p, "%.2f" % v["Tin"], "%.2f" % v["Tout"], "" if tt is None else "%.1f" % tt, "" if t73 is None else "%.1f" % t73,
                         "" if tt is None else "%.2f" % (v["Tout"] - tt), "" if (tt is None or t73 is None) else "%.2f" % (t73 - tt), "%.0f" % v["Q_btuhr"]])
            if tt is not None and rec["set"] == "primary":
                errs.append(v["Tout"] - tt)
                if t73 is not None:
                    errs73.append(t73 - tt)
        to_model = {p: v["Tout"] for p, v in res.items()}
        to_test = {p: o[0] for p, o in outlets[tp].items()}
        to_73 = {p: o[1] for p, o in outlets[tp].items()}
        sm = system_metrics(rec, props, to_model, to_test, to_73)
        qm, tm = sm["model"]
        qt, tt_ = sm["test"]
        q73, t73m = sm["1973"]
        sysrows.append([tp, rec["set"], "%.0f" % qm, "" if qt is None else "%.0f" % qt, "" if q73 is None else "%.0f" % q73, "%.2f" % tm, "" if tt_ is None else "%.2f" % tt_, "" if t73m is None else "%.2f" % t73m])
        if rec["set"] == "primary" and qt:
            qerr.append(100 * (qm / qt - 1))
            if q73:
                qerr73.append(100 * (q73 / qt - 1))
            tmix_err.append(tm - tt_)
            t73p, ttp = sysout[tp]
            if ttp is not None:
                tmix_err_printed.append(tm - ttp)
                if t73p is not None:
                    tmix73_printed.append(t73p - ttp)

    def stat(a):
        if not a:
            return "n=0"
        return "n=%d RMS %.2f max %.2f bias %+.2f" % (len(a), math.sqrt(sum(x * x for x in a) / len(a)), max(abs(x) for x in a), sum(a) / len(a))

    print("points:", ",".join(tps))
    print("panel outlet error (F), this calc minus test :", stat(errs))
    print("panel outlet error (F), 1973 model minus test:", stat(errs73))
    print("bank heat error (%%), this calc: %s" % stat(qerr))
    print("bank heat error (%%), 1973 model: %s" % stat(qerr73))
    print("mixed main outlet error (F) vs printed test value, this calc:", stat(tmix_err_printed))
    print("mixed main outlet error (F) vs printed test value, 1973 model:", stat(tmix73_printed))
    print("mixed main outlet error (F), this calc minus test recomputed from measured leg ends:", stat(tmix_err))
    if args.out:
        with open(args.out, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["test_point", "set", "panel", "Tin_F_calc_chain", "Tout_calc_F", "Tout_test_F", "Tout_1973model_F", "err_calc_minus_test_F", "err_1973_minus_test_F", "Q_panel_calc_Btuhr"])
            w.writerows(rows)
        with open(os.path.splitext(args.out)[0] + "_system.csv", "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["test_point", "set", "Qbank_calc_Btuhr", "Qbank_test_from_T_Btuhr", "Qbank_1973_from_T_Btuhr", "Tmix_main_calc_F", "Tmix_main_test_from_T_F", "Tmix_main_1973_from_T_F"])
            w.writerows(sysrows)


if __name__ == "__main__":
    main()
