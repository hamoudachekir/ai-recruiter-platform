# LaTeX Workshop (Alt+V) expects the PDF in build/
$pdf_mode = 1;
$aux_dir = 'build';
$out_dir = 'build';
set_tex_cmds('-synctex=1 -interaction=nonstopmode %O %S');
