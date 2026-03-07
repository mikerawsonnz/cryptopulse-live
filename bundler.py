import os

IGNORE_DIRS = {'.git', '__pycache__', 'venv', 'env', '.replit', '.upm', 'data', 'logs', 'node_modules', 'dist', '.cache', '.config', '.local', 'attached_assets'}
IGNORE_FILES = {'poetry.lock', 'pyproject.toml', 'bundler.py', '.env', 'package-lock.json', 'full_project_code.txt'}
INCLUDE_EXT = {'.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.txt', '.sql', '.toml'}

def bundle_project():
    output_file = "full_project_code.txt"
    
    with open(output_file, "w", encoding="utf-8") as outfile:
        outfile.write("--- PROJECT STRUCTURE ---\n")
        for root, dirs, files in os.walk("."):
            dirs[:] = sorted([d for d in dirs if d not in IGNORE_DIRS])
            level = root.replace(".", "").count(os.sep)
            indent = " " * 4 * (level)
            outfile.write(f"{indent}{os.path.basename(root)}/\n")
            subindent = " " * 4 * (level + 1)
            for f in sorted(files):
                if f not in IGNORE_FILES and os.path.splitext(f)[1] in INCLUDE_EXT:
                    outfile.write(f"{subindent}{f}\n")
        
        outfile.write("\n\n--- FILE CONTENTS ---\n")

        for root, dirs, files in os.walk("."):
            dirs[:] = sorted([d for d in dirs if d not in IGNORE_DIRS])
            
            for file in sorted(files):
                if file in IGNORE_FILES: continue
                if os.path.splitext(file)[1] not in INCLUDE_EXT: continue
                
                file_path = os.path.join(root, file)
                
                try:
                    outfile.write(f"\n{'='*20}\nSTART OF FILE: {file_path}\n{'='*20}\n")
                    with open(file_path, "r", encoding="utf-8") as infile:
                        content = infile.read()
                        if "api_key" in content.lower() or "secret" in content.lower():
                            outfile.write("# [NOTE: POTENTIAL SENSITIVE DATA REDACTED BY USER BEFORE UPLOAD]\n")
                        outfile.write(content)
                    outfile.write(f"\nEND OF FILE: {file_path}\n")
                except Exception as e:
                    outfile.write(f"\nCould not read {file_path}: {e}\n")

    print(f"Done! Your full project code is in '{output_file}'.")

if __name__ == "__main__":
    bundle_project()
