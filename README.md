# Termi
<img width="3768" height="1977" alt="Termi" src="https://github.com/user-attachments/assets/c6f1568c-21a0-4304-a43f-b4fa438a5d62" />
Termi is a desktop wrapper that provides a friendly, cozy chat interface for powerful Agentic AI CLIs (like the antigravity cli or Claude Agent SDK). 

I originally built this tool for my wife to empower her to use advanced CLI capabilities without having to learn terminal commands. It worked so well that I realized a lot more people could benefit from it! It bridges the gap between powerful developer tools and accessible user interfaces.


## 🌟 Why this exists

Agentic RAGs and AI CLI tools are incredibly powerful, but interacting with them through a terminal can be intimidating and tedious for non-developers. Termi solves this by offering:

- **A Familiar Chat Window:** Interact with your agent just like you would with any modern messenger, but with the full power of an agentic RAG behind it.
- **Full CLI Support Under the Hood:** The interface wraps the CLI perfectly. You still get 100% of the underlying agent's capabilities (executing commands, reading files, searching the web).
- **Native File Explorer:** A built-in file explorer allows you to effortlessly drag and drop files and folders directly into the chat. The path is automatically resolved and inserted.
- **Approval Cards (Human-in-the-Loop):** Nothing with external impact happens without your explicit approval. The agent proposes actions (like executing a bash script or editing a file), and you get a clean UI card to approve or deny it.
- **Skill Chips:** Quickly access the tools your agent is equipped with via clickable chips.
- **Model Picker:** Choose the model from a dropdown. With the Antigravity CLI (gy), the list comes from `agy models`; with Claude it comes from the SDK.
- **Bilingual Support:** Full interface localization for English and German.

## 🚀 Getting Started

*(Instructions for installing and running the Electron app go here)*

1. Clone this repository
2. Run `npm install`
3. Run `npm start` to launch the app in development mode

## ⚖️ License & Dual-Licensing

Termi is free open-source software, licensed under the **GNU General Public License v3.0 (GPLv3)**.

- **Community & Personal Use:** You are free to run, study, share, and modify Termi under the terms of the GPLv3. Any distributed modifications must also remain open source under the GPLv3.
- **Contributions:** We welcome contributions! Contributing requires accepting our lightweight [Contributor License Agreement (CLA)](CLA.md).
- **Commercial & Enterprise Licensing:** If you or your organization wish to integrate or distribute Termi without the copyleft obligations of the GPLv3 (e.g., in a proprietary corporate deployment or embedded within a closed-source solution), commercial licenses are available. Please get in touch to discuss options.

