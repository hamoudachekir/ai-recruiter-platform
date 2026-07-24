\usepackage{silence}
\WarningsOff*
\LoadClassWithOptions{report}
\usepackage[a4paper,left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm]{geometry}
\emergencystretch=3em % laisse TeX étirer légèrement l'espacement plutôt que de déborder en marge
\usepackage{environ}
\usepackage{verse}
\usepackage[table]{xcolor}
\usepackage[explicit]{titlesec}
\usepackage{chngcntr}
\usepackage{fancyhdr}
\usepackage{lastpage} % pagination « page/total » (consigne ESPRIT)
\usepackage{caption}
\usepackage{subcaption}
\usepackage[hidelinks]{hyperref}
\usepackage{needspace}% http://ctan.org/pkg/needspace
\usepackage{pdfpages}
\usepackage{chngcntr}
\usepackage{enumitem}
\usepackage[bottom]{footmisc}
\usepackage[french]{babel}
\usepackage[french]{varioref}
\usepackage{acronym}
\usepackage[french]{minitoc}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[skins]{tcolorbox}
\usepackage[french]{babel}
\usepackage[french]{varioref}
\usepackage[export]{adjustbox}
\usepackage{setspace}
\usepackage{minted}
\usepackage{color}
\usepackage{tabularx}
\usepackage{float}     % provides [H] specifier, forces exact figure placement
\usepackage{booktabs}
\usepackage{ctable}
\usepackage{graphicx}
\usepackage{multirow}
\usepackage{tikz}
\usetikzlibrary{positioning, arrows.meta, fit, backgrounds, shapes.geometric}
\usepackage{seqsplit}
\usepackage{fontenc}
\usepackage{wrapfig}
\usepackage{setspace}
% Widow control without the aggressive [all] mode (which leaves near-empty pages).
\usepackage{nowidow}
\usepackage{acronym}
\usepackage{array,ragged2e}
\usepackage{enumitem}
\usepackage{xcolor}
\definecolor{Gris1}{RGB}{116,134,170}
\definecolor{Gris2}{RGB}{249,249,249}

\usepackage[titletoc,title]{appendix}

\def\defaultFont{ptm}
\renewcommand*{\familydefault}{\defaultFont}
\renewcommand\UrlFont{\ignore{Actually do nothing!}}


\definecolor{tableRow1}{RGB}{210,234,241}
\definecolor{gray75}{gray}{0.75}

\definecolor{reportType}{HTML}{013873}


 \newlength\BoxWd
 \setlength\BoxWd{10mm}
 \newlength\Aux
  % chapter tiltes formatting
  \titleformat{\chapter}[display]%
    {\fontsize{26}{6}\bfseries\selectfont%
      \settowidth\Aux{\textcolor{white}{\Huge\thechapter}}%
      \ifnum\Aux>\BoxWd%
        \setlength\BoxWd{\Aux}%
      \else\fi%
    }%
    {%
      {\hspace*{-1.5mm}\normalfont\fontsize{14}{6}\selectfont{Chapitre}}\\%
      \colorbox{black}{%
        \parbox[c][20mm][t]{\BoxWd}{%
          \vspace{2.5mm}\centering\textcolor{white}{\Huge\thechapter}%
        }%
      }%
    }%
    {-10mm}%
    {%
      \vspace{-5mm}\hspace*{15mm}\titlerule\\\\\hspace*{15mm}#1%
    } %\centering

  % chapter tiltes formatting
  \titleformat{name=\chapter, numberless}[display]%
    {\fontsize{26}{6}\bfseries\selectfont%
      \settowidth\Aux{\textcolor{white}{\Huge\thechapter}}%
      \ifnum\Aux>\BoxWd%
        \setlength\BoxWd{\Aux}%
      \else\fi%
    }%
    {%
      {\hspace*{-1.5mm}\normalfont\fontsize{14}{6}\selectfont{~}}\\%
      \colorbox{black}{%
        \parbox[c][20mm][t]{\BoxWd}{%
          \vspace{2.5mm}\centering\textcolor{white}{~}%
        }%
      }%
    }%
    {-10mm}%
    {%
      \vspace{-5mm}\hspace*{15mm}\titlerule\\\\\hspace*{15mm}#1%
    } %\centering

% chapter tiltes spacing
\titlespacing*{\chapter}{0pt}{0pt}{30pt}

\titleformat{\section}[block]%
  {\Large\bfseries}{\thesection}%
  {10pt}{\Large{\bfseries{#1}}}

\titleformat{\paragraph}[block]%
  {\normalfont\normalsize\bfseries}%
  {\theparagraph}{1em}{#1}
  
\captionsetup{labelfont=bf,font={singlespacing},justification=RaggedRight,font=small,textfont=sc, textfont=bf }
% Légendes abrégées par type (consigne ESPRIT : Fig. 1, Tab. 1, etc.)
\captionsetup[figure]{name=Fig.}
\captionsetup[table]{name=Tab.}


\fancypagestyle{MyStyle}{
  \renewcommand{\headrulewidth}{0pt}
  \renewcommand{\footrulewidth}{0.5pt}
  \fancyhead[L]{}

  \fancyfoot[R]{\fontsize{12}{12}\selectfont \thepage/\pageref{LastPage}}% Numéro de page « x/y » en bas à droite (consigne ESPRIT)
  
  \fancyfoot[L]{\fontsize{12}{12}\selectfont ESPRIT}% Right header

}

\renewcommand{\chaptermark}[1]{\markboth{\MakeUppercase{#1}}{}}



\fancypagestyle{plain}{
  \fancyhf{}% Clear header/footer

  \renewcommand{\headrulewidth}{0.5pt}
  \renewcommand{\footrulewidth}{0.5pt}

  \fancyhead[L]{\fontsize{12}{12}\selectfont\textsc{\MakeLowercase{\leftmark}}}% Left header
 

  \fancyfoot[R]{\fontsize{12}{12}\selectfont \thepage/\pageref{LastPage}}% Numéro de page « x/y » en bas à droite (consigne ESPRIT)
  
  \fancyfoot[L]{\fontsize{12}{12}\selectfont\ ESPRIT}% Right header

}

\setlength{\fboxsep}{0mm}%
\setlength{\fboxrule}{1pt}%

% Set the footnote counter to be continuous over the whole document
\counterwithout{footnote}{chapter}
\pagestyle{plain}% Set page style to plain.


\newcommand{\ignore}[2]{\hspace{0mm}#2}

\newcommand{\HRule}[1][\linewidth]{%
  % Arg1 : Width      : \linewidth
  \rule{#1}{0.5mm}%
}


\newcommand{\printBigName}{%
  \leavevmode\color{titleColorGray}\setmainfont{Cambria}\fontsize{23pt}{23pt}\selectfont\textbf{\@name}
}

\newcommand{\putPhoto}[1] {%
  \includegraphics[width=35mm, height=35mm]{#1}
  %\tcbincludegraphics[blank,arc=0.4cm]{#1}
}

\newcommand{\highlight}[1] {%
  \textit{#1}%
}

% Figure « logo » : image centrée de hauteur fixe + légende numérotée.
% Usage : \logofig{images/fichier.png}{Légende}{fig:label}
\newcommand{\logofig}[3]{%
  \begin{figure}[H]%
    \centering
    \includegraphics[max width=3.2cm, max height=1.6cm]{#1}%
    \caption{#2}%
    \label{#3}%
  \end{figure}%
}

\setcounter{secnumdepth}{5}
\setcounter{tocdepth}{3}
\setcounter{minitocdepth}{3}  % Sommaire de chaque chapitre : sections + sous-sections + sous-sous-sections

\renewcommand\theparagraph{\alph{paragraph})}
\renewcommand\thesubparagraph{\roman{subparagraph}.}

% Consigne ESPRIT : alinéa de première ligne de 0,5 cm, pas d'espace vide entre paragraphes
\setlength{\parindent}{0.5cm} % Alinéa de première ligne
\setlength{\parskip}{0pt}     % Pas d'espacement supplémentaire entre paragraphes
\setlist[enumerate]{itemsep=-0.35\baselineskip} % Spacing in enumerates

% Remove hyphens
\hyphenpenalty=10000
\exhyphenpenalty=10000


    \NewEnviron{pfe} {%
      \begingroup%
      \BODY%
      \endgroup%
    }%
