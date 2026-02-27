# Overview

Masquerade is a high-performance video processing application that enables interactive masking and frame extraction from video files. The application specializes in processing medical imaging files (including DICOM) and standard video formats with a focus on speed and efficiency. The core workflow involves uploading a video, creating an interactive mask on the first frame, and applying that mask to all frames in parallel processing.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **React SPA**: Built with React 18, TypeScript, and Vite for fast development and hot module replacement
- **UI Framework**: Utilizes shadcn/ui components with Radix UI primitives for accessible, professional interface
- **Styling**: TailwindCSS with CSS variables for theming and responsive design
- **Canvas Integration**: Fabric.js for interactive masking tools with zoom, pan, and drawing capabilities
- **State Management**: React Query for server state management and real-time data synchronization
- **Real-time Updates**: Socket.IO client for live progress tracking during video processing

## Backend Architecture
- **Express.js Server**: RESTful API with middleware for logging, error handling, and request parsing
- **Worker Pool Pattern**: Multi-threaded video processing using Node.js worker threads for parallel frame processing
- **Memory Storage**: In-memory data store for development with interface design for future database integration
- **Socket.IO Integration**: WebSocket server for real-time progress updates and job status communication
- **File Processing Pipeline**: Streaming approach to handle large video files without memory accumulation

## Video Processing Engine
- **FFmpeg Integration**: Core video processing using fluent-ffmpeg for metadata extraction and frame extraction
- **Sharp Image Processing**: High-performance image manipulation for mask application and format conversion
- **Parallel Processing**: Worker pool design enables 4+ frames per second processing speed
- **Batch Processing**: Frames processed in configurable batches to optimize memory usage and performance
- **Template Masking**: Single mask definition applied to all frames for consistent processing

## Data Storage Solutions
- **PostgreSQL Schema**: Drizzle ORM with schema definitions for video jobs, frame batches, and processing progress
- **File Storage**: Local file system for temporary video uploads and processed frame outputs
- **Memory Management**: Automatic garbage collection and streaming transforms to prevent memory leaks
- **Archive Generation**: Automatic ZIP creation of processed frames using archiver library

## External Dependencies

- **Neon Database**: PostgreSQL hosting service for production data persistence
- **FFmpeg**: Video processing and metadata extraction engine
- **Sharp**: High-performance image processing library for Node.js
- **Fabric.js**: Interactive canvas library for mask creation and editing
- **Socket.IO**: Real-time bidirectional communication between client and server
- **Drizzle ORM**: Type-safe database ORM with PostgreSQL dialect
- **Radix UI**: Accessible component primitives for professional UI development
- **TanStack Query**: Powerful data synchronization for React applications
- **Multer**: Multipart form data handling for file uploads up to 500MB
- **Archiver**: ZIP file creation for batch download of processed frames