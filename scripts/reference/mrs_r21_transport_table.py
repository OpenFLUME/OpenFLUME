"""Build the committed R21 transport table (validation/data/digitized/mrs/mrs_r21_transport_table.csv).

Transport of R21 (dichlorofluoromethane) is not in CoolProp 8.0.0.  The REFPROP fluid file R21.FLD (transport block added by
M. L. Huber, 2010) carries an Extended Corresponding States (ECS) model with R134a as the reference fluid, in the framework of
Huber, Laesecke and Perkins, Ind. Eng. Chem. Res. 42, 3163 (2003).  CoolProp contains the same ECS machinery for other
refrigerants (for example R22), so the R21 parameters from the REFPROP file are injected into the CoolProp R21 JSON here and
CoolProp evaluates viscosity and thermal conductivity.  Density, cp and enthalpy come from the CoolProp R21 equation of state.
"""
import csv, json, sys
import CoolProp.CoolProp as CP

P_PA = 1.5e6
RHOC_MOL_M3 = 5110.7656  # critical density of R21, mol/m3 (REFPROP file, 5.1107656 mol/L)

# Parameters of the R21 transport block in REFPROP R21.FLD, mapped onto the CoolProp ECS JSON schema.
ECS = {
    "conductivity": {
        "BibTeX": "REFPROP-R21-ECS",
        "f_int": {"T_reducing": 1.0, "T_reducing_units": "K", "a": [1.32e-3], "t": [0]},
        "psi": {"a": [1.03377, -2.23145e-2], "rhomolar_reducing": RHOC_MOL_M3, "rhomolar_reducing_units": "mol/m^3", "t": [0, 1]},
        "q_D": 2.0e9, "q_D_units": "m", "reference_fluid": "R134a", "type": "ECS",
    },
    "viscosity": [{
        "BibTeX": "REFPROP-R21-ECS", "epsilon_over_k": 358.60, "epsilon_over_k_units": "K",
        "psi": {"a": [1.99918, -0.688312, 0.113652], "rhomolar_reducing": RHOC_MOL_M3, "rhomolar_reducing_units": "mol/m^3", "t": [0, 1, 2]},
        "reference_fluid": "R134a", "sigma_eta": 4.697e-10, "sigma_eta_units": "m", "type": "ECS",
    }],
}

def f2k(f): return (f - 32.0) / 1.8 + 273.15

def register_r21_transport(name="R21x"):
    """Return the name of a CoolProp fluid that is R21 plus the ECS transport block."""
    import os, urllib.request
    path = os.environ.get("R21_JSON")
    if path:
        d = json.load(open(path))
    else:
        url = "https://raw.githubusercontent.com/CoolProp/CoolProp/master/dev/fluids/R21.json"
        d = json.loads(urllib.request.urlopen(url, timeout=60).read())
    d["TRANSPORT"] = ECS
    d["INFO"]["NAME"] = name
    d["INFO"]["REFPROP_NAME"] = "R21"
    d["INFO"]["CAS"] = "0-0-0"
    CP.add_fluids_as_JSON("HEOS", json.dumps(d))
    return name

def main(out):
    nm = register_r21_transport()
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["T_F", "T_K", "rho_kg_m3", "cp_J_kgK", "h_J_kg_CoolProp_IIR", "mu_Pa_s", "k_W_mK"])
        t = -95.0
        while t <= 220.0 + 1e-9:
            T = f2k(t)
            w.writerow(["%g" % t, "%.3f" % T, "%.2f" % CP.PropsSI("D", "T", T, "P", P_PA, "R21"),
                        "%.1f" % CP.PropsSI("C", "T", T, "P", P_PA, "R21"), "%.1f" % CP.PropsSI("H", "T", T, "P", P_PA, "R21"),
                        "%.5e" % CP.PropsSI("V", "T", T, "P", P_PA, nm), "%.5f" % CP.PropsSI("L", "T", T, "P", P_PA, nm)])
            t += 5.0

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "mrs_r21_transport_table.csv")
