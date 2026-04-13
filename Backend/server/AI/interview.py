import os
import glob
import shutil
import subprocess
import tempfile
import wave
import sounddevice as sd
from scipy.io.wavfile import write
import whisper
from transformers import pipeline, set_seed
from fpdf import FPDF
import re
from datetime import datetime
import torch

WHISPER_MODEL_NAME = "base.en"
WHISPER_LANGUAGE = "en"
FFMPEG_EXECUTABLE = "ffmpeg.exe"

# 🔧 Nettoyage du texte renforcé
def clean_text(text):
    replacements = {
        '•': '-', '’': "'", '“': '"', '”': '"', '…': '...',
        '\u2022': '-', '\u2013': '-', '\u2014': '-'
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    text = re.sub(r'[^\w\s\u00C0-\u017F.,:;!?\'\"()\-\n\r]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()

# 🎙️ Enregistrement audio fiable
def record_audio(filename, duration=60, fs=44100):
    try:
        print(f"\n🔊 Enregistrement de {duration}s...")
        audio_data = sd.rec(int(duration * fs), samplerate=fs, channels=2)
        sd.wait()
        write(filename, fs, audio_data)
        print(f"✅ Fichier audio sauvegardé : {filename}")
        return True
    except Exception as e:
        print(f"❌ Erreur d'enregistrement : {str(e)}")
        return False


def _ffmpeg_supports_audio(ffmpeg_binary):
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_wav:
            temp_wav_path = temp_wav.name

        try:
            # Create a tiny valid WAV file to ensure ffmpeg can decode WAV input.
            with wave.open(temp_wav_path, "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(16000)
                wav_file.writeframes(b"\x00\x00" * 160)

            probe = subprocess.run(
                [ffmpeg_binary, "-hide_banner", "-v", "error", "-i", temp_wav_path, "-f", "null", "-"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return probe.returncode == 0
        finally:
            if os.path.exists(temp_wav_path):
                os.remove(temp_wav_path)
    except Exception:
        return False


def ensure_ffmpeg_ready():
    candidates = []

    explicit_ffmpeg = os.environ.get("VOICE_ENGINE_FFMPEG_PATH", "").strip()
    if explicit_ffmpeg:
        candidates.append(explicit_ffmpeg)

    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        winget_patterns = [
            os.path.join(
                local_app_data,
                "Microsoft",
                "WinGet",
                "Packages",
                "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
                "ffmpeg-*-full_build",
                "bin",
                FFMPEG_EXECUTABLE,
            ),
            os.path.join(
                local_app_data,
                "Microsoft",
                "WinGet",
                "Packages",
                "*FFmpeg*",
                "*full_build",
                "bin",
                FFMPEG_EXECUTABLE,
            ),
        ]
        for pattern in winget_patterns:
            candidates.extend(sorted(glob.glob(pattern), reverse=True))

    candidates.extend(
        [
            os.path.join("C:\\", "ffmpeg", "bin", FFMPEG_EXECUTABLE),
            os.path.join("C:\\", "Program Files", "ffmpeg", "bin", FFMPEG_EXECUTABLE),
            os.path.join("C:\\", "Program Files", "FFmpeg", "bin", FFMPEG_EXECUTABLE),
        ]
    )

    ffmpeg_from_path = shutil.which("ffmpeg")
    if ffmpeg_from_path:
        candidates.append(ffmpeg_from_path)

    seen = set()
    for candidate in candidates:
        resolved = os.path.abspath(os.path.expandvars(os.path.expanduser(str(candidate))))
        dedupe_key = resolved.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        if not os.path.isfile(resolved):
            continue
        if not _ffmpeg_supports_audio(resolved):
            continue

        ffmpeg_dir = os.path.dirname(resolved)
        path_parts = [part.lower() for part in os.environ.get("PATH", "").split(os.pathsep) if part]
        if ffmpeg_dir.lower() not in path_parts:
            os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

        os.environ["VOICE_ENGINE_FFMPEG_PATH_RESOLVED"] = resolved
        return resolved

    return None

# 🔎 Transcription optimisée
def transcribe_audio(file):
    if not os.path.exists(file):
        print(f"❌ Fichier audio introuvable : {file}")
        return ""
    
    try:
        print("\n🔄 Transcription en cours...")
        ffmpeg_binary = ensure_ffmpeg_ready()
        if not ffmpeg_binary:
            print("❌ ffmpeg valide introuvable. Installez FFmpeg (full build) ou définissez VOICE_ENGINE_FFMPEG_PATH.")
            return ""

        print(f"🎛️ ffmpeg détecté : {ffmpeg_binary}")
        model = whisper.load_model(WHISPER_MODEL_NAME)
        result = model.transcribe(file, language=WHISPER_LANGUAGE, fp16=torch.cuda.is_available())
        return clean_text(result['text'])
    except Exception as e:
        print(f"❌ Échec de la transcription : {str(e)}")
        return ""

# 🗣️ Structure du dialogue améliorée
def format_dialogue(text):
    if not text:
        return ""
    
    lines = []
    current_speaker = "RH"
    
    for sentence in re.split(r'(?<=[.!?])\s+', text):
        sentence = sentence.strip()
        if not sentence:
            continue
            
        # Détection du locuteur
        if re.search(r'(^|\W)(Bonjour|Merci|Question|Alors)(\W|$)', sentence, re.IGNORECASE):
            current_speaker = "RH"
        elif re.search(r'\b(je\s|j\'ai|mon\s|ma\s|mes\s|moi\s)', sentence.lower()):
            current_speaker = "Candidat"
            
        lines.append(f"{current_speaker}: {sentence.capitalize()}")
        
        # Alternance par défaut
        current_speaker = "Candidat" if current_speaker == "RH" else "RH"
    
    return "\n".join(lines)

# ✂️ Résumé avec BARTHEZ configuré
def generate_summary(text):
    if not text:
        return "Aucun contenu à résumer"
    
    try:
        print("\n🧠 Génération du résumé...")
        set_seed(42)  # Pour la reproductibilité
        
        summarizer = pipeline(
            "summarization",
            model="moussaKam/barthez-orangesum-title",
            tokenizer="moussaKam/barthez-orangesum-title",
            device=0 if torch.cuda.is_available() else -1
        )
        
        # Ajustement automatique de la longueur
        input_length = len(text.split())
        max_len = min(200, max(50, input_length//2))
        min_len = min(30, max_len//2)
        
        summary = summarizer(
            text,
            max_length=max_len,
            min_length=min_len,
            num_beams=4,
            early_stopping=False,
            no_repeat_ngram_size=3,
            truncation=True
        )[0]['summary_text']
        
        return "• " + clean_text(summary).replace('. ', '\n• ')
    except Exception as e:
        print(f"❌ Échec du résumé : {str(e)}")
        return "[Résumé non disponible]"

# 📄 PDF professionnel
def create_pdf_report(content, summary, filename, candidate):
    try:
        pdf = FPDF()
        pdf.add_page()
        pdf.set_auto_page_break(True, margin=15)
        
        # Configuration des polices
        try:
            pdf.add_font('DejaVu', '', 'DejaVuSans.ttf', uni=True)
            pdf.set_font('DejaVu', '', 12)
        except:
            pdf.set_font('Arial', '', 12)
            content = content.encode('latin-1', 'replace').decode('latin-1')
            summary = summary.encode('latin-1', 'replace').decode('latin-1')
        
        # En-tête
        pdf.set_font_size(16)
        pdf.cell(0, 10, f"COMPTE-RENDU D'ENTRETIEN - {candidate.upper()}", 0, 1, 'C')
        pdf.ln(5)
        
        # Métadonnées
        pdf.set_font_size(10)
        pdf.cell(0, 6, f"Date : {datetime.now().strftime('%d/%m/%Y %H:%M')} | Durée : 1 minute", 0, 1)
        pdf.ln(10)
        
        # Section Résumé
        pdf.set_font_size(14)
        pdf.cell(0, 8, "SYNTHÈSE", 0, 1)
        pdf.set_font_size(11)
        pdf.multi_cell(0, 6, summary)
        pdf.ln(10)
        
        # Dialogue complet
        pdf.set_font_size(14)
        pdf.cell(0, 8, "ÉCHANGE COMPLET", 0, 1)
        pdf.set_font_size(10)
        
        for line in content.split('\n'):
            if line.startswith("RH:"):
                pdf.set_text_color(0, 0, 128)
            elif line.startswith("Candidat:"):
                pdf.set_text_color(0, 100, 0)
            pdf.multi_cell(0, 5, line)
            pdf.ln(2)
            pdf.set_text_color(0, 0, 0)
        
        # Pied de page
        pdf.set_y(-15)
        pdf.set_font_size(8)
        pdf.cell(0, 10, f"Document généré automatiquement - {filename}", 0, 0, 'C')
        
        pdf.output(filename)
        print(f"\n✅ Rapport PDF généré : {filename}")
        return True
    except Exception as e:
        print(f"❌ Échec de génération PDF : {str(e)}")
        return False

def main():
    print("\n" + "="*50)
    print("  SYSTÈME D'ANALYSE D'ENTRETIEN")
    print("="*50)
    
    candidate = input("\nNom du candidat : ").strip().title() or "Candidat"
    base_name = f"Entretien_{candidate.replace(' ', '_')}_{datetime.now().strftime('%Y%m%d_%H%M')}"
    
    # 1. Enregistrement audio
    if not record_audio(f"{base_name}.wav"):
        return
    
    # 2. Transcription
    transcript = transcribe_audio(f"{base_name}.wav")
    if not transcript:
        return
    
    with open(f"{base_name}_transcription.txt", "w", encoding='utf-8') as f:
        f.write(transcript)
    
    # 3. Analyse
    dialogue = format_dialogue(transcript)
    summary = generate_summary(dialogue)
    
    # 4. Génération du rapport
    if create_pdf_report(dialogue, summary, f"{base_name}.pdf", candidate):
        print("\n" + "="*50)
        print("  RÉSULTATS FINAUX")
        print(f"• Audio : {base_name}.wav")
        print(f"• Transcription : {base_name}_transcription.txt")
        print(f"• Rapport : {base_name}.pdf")
        print("="*50 + "\n")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nOpération annulée par l'utilisateur")
    except Exception as e:
        print(f"\n❌ ERREUR : {str(e)}")