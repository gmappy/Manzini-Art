FROM node:20-alpine

# Set non-root user (best practice on Hugging Face Spaces)
USER node
WORKDIR /home/node/app

# Copy project files
COPY --chown=node:node . .

# Hugging Face Spaces routes traffic via port 7860 by default
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
