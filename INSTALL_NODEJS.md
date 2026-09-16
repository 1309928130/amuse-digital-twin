# How to Install Node.js on Windows

## Option 1: Download from Official Website (Recommended)

1. **Visit the Node.js website:**
   - Go to: https://nodejs.org/
   - Download the **LTS (Long Term Support)** version for Windows

2. **Run the installer:**
   - Double-click the downloaded `.msi` file
   - Follow the installation wizard
   - Make sure to check "Add to PATH" option (usually checked by default)
   - Click "Install"

3. **Verify installation:**
   - Close and reopen your terminal/Git Bash
   - Run: `node --version`
   - Run: `npm --version`
   - Both should show version numbers

## Option 2: Using Chocolatey (if you have it installed)

If you have Chocolatey package manager installed, run:
```bash
choco install nodejs-lts
```

## Option 3: Using winget (Windows Package Manager)

Open PowerShell or Command Prompt (not Git Bash) and run:
```powershell
winget install OpenJS.NodeJS.LTS
```

## After Installation

1. **Close and reopen your terminal/Git Bash** (important for PATH to update)

2. **Verify it works:**
   ```bash
   node --version
   npm --version
   ```

3. **Then install project dependencies:**
   ```bash
   npm install
   ```

## Troubleshooting

If `npm` still doesn't work after installation:
- Make sure you **closed and reopened** your terminal
- Check if Node.js is in your PATH:
  ```bash
   echo $PATH
   ```
- Try restarting your computer
- Manually add Node.js to PATH if needed (usually: `C:\Program Files\nodejs\`)

