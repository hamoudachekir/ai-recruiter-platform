# Local latexmk configuration for this thesis.
# The custom class (pfe-report.cls) loads the `minted` package, which shells
# out to Pygments and therefore requires pdflatex to run with -shell-escape.
# Prepending it here means every build (VS Code LaTeX Workshop *and* the
# command line) gets the flag automatically, without touching global settings.
set_tex_cmds('-synctex=1 -shell-escape %O %S');
$pdf_mode = 1;

# Keep the project folder clean: send every generated file (aux, log, .mtc,
# .fls, .fdb_latexmk, synctex AND the final PDF) into a build/ subfolder.
# MiKTeX's -aux-directory keeps the build dir on the input search path, so
# minitoc's .mtc files are still found. Mirrored in VS Code via
# "latex-workshop.latex.outDir": "%DIR%/build".
$aux_dir = 'build';
$out_dir = 'build';
