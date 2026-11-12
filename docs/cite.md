---
title: How to cite OpenFLUME
description: BibTeX and APA citations for OpenFLUME (DOI 10.5281/zenodo.22051608), version-specific citation, and citing CoolProp and NASA CEA.
---

# How to cite OpenFLUME

If OpenFLUME contributes to your research, teaching material, or a
published analysis, please cite the software. The canonical metadata is in
[`CITATION.cff`](../CITATION.cff), which GitHub's "Cite this repository"
button reads.

## Software citation

**APA**

> Rising, J. (2026). _OpenFLUME: Open FLUid Model Environment_ (Version 0.4.1) [Computer software]. Zenodo. https://doi.org/10.5281/zenodo.22051608

**BibTeX**

```bibtex
@software{rising_openflume_2026,
  author    = {Rising, John},
  title     = "{OpenFLUME}: Open {FLUid} Model Environment",
  year      = {2026},
  version   = {0.4.1},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.22051608},
  url       = {https://doi.org/10.5281/zenodo.22051608},
  license   = {MIT},
  note      = {Source code: https://github.com/OpenFLUME/OpenFLUME}
}
```

biblatex supports `@software`. With a classic BibTeX style that lacks it,
change the entry type to `@misc` and keep the fields.

## Citing a specific version

Results depend on the solver version, so cite the version you ran. The
citation above is for 0.4.1. Zenodo archives each release, and the
[Zenodo record](https://doi.org/10.5281/zenodo.22051608) lists the versions
and their DOIs. For reproducible work, also record:

- the release tag or commit hash (`git rev-parse HEAD`), or the `openflume`
  Python package version;
- the model file (`.fn`). Every run hashes its configuration, and exports
  carry the model name, a solver-settings summary, and that config hash
  ([§8.7 Result Provenance](user-manual.md#_8-7-result-provenance)). Quote the
  hash alongside the result.

A `.fn` file holds the model but not the solver version, so state the
version alongside any model you publish.

## Paper in preparation

A paper on OpenFLUME's formulation and verification is in preparation for
the Journal of Open Source Software (JOSS) and arXiv. Its citation will be
added here and to `CITATION.cff`; until then, cite the software DOI above.

## Citing the libraries OpenFLUME builds on

### CoolProp (real-fluid properties)

Cite CoolProp for any model that uses the real-fluid equation of state (the
CoolProp catalogue):

> Bell, I. H., Wronski, J., Quoilin, S., & Lemort, V. (2014). Pure and pseudo-pure fluid thermophysical property evaluation and the open-source thermophysical property library CoolProp. _Industrial & Engineering Chemistry Research_, 53(6), 2498–2508. https://doi.org/10.1021/ie4033999

```bibtex
@article{bell_coolprop_2014,
  author  = {Bell, Ian H. and Wronski, Jorrit and Quoilin, Sylvain and Lemort, Vincent},
  title   = {Pure and Pseudo-pure Fluid Thermophysical Property Evaluation and
             the Open-Source Thermophysical Property Library {CoolProp}},
  journal = {Industrial \& Engineering Chemistry Research},
  year    = {2014},
  volume  = {53},
  number  = {6},
  pages   = {2498--2508},
  doi     = {10.1021/ie4033999}
}
```

### NASA CEA (combustion)

The reacting-junction combustion model uses chamber-equilibrium tables
generated offline with NASA CEA ([combustion](combustion.md)). If you use
reacting junctions or the LOX/RP-1 and LOX/CH₄ tables, cite:

> Gordon, S., & McBride, B. J. (1994). _Computer program for calculation of complex chemical equilibrium compositions and applications. I. Analysis_ (NASA Reference Publication 1311). NASA Lewis Research Center.

```bibtex
@techreport{gordon_cea_1994,
  author      = {Gordon, Sanford and McBride, Bonnie J.},
  title       = {Computer Program for Calculation of Complex Chemical
                 Equilibrium Compositions and Applications.
                 {I}. Analysis},
  institution = {NASA Lewis Research Center},
  type        = {NASA Reference Publication},
  number      = {RP-1311},
  year        = {1994}
}
```

### Benchmarks and correlations

If you quote a benchmark comparison or rely on a specific correlation (for
example the GFSSP TFAWS-2007 compressible-flow study, NBS Report 9264, or
Darr–Hartwig chilldown), also cite the original source. User manual
Appendix E and each [validation report](validation/index.md) list the
references.
